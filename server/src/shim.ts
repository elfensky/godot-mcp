/**
 * Stdio-to-HTTP shim.
 *
 * When an MCP client spawns `node dist/index.js` expecting stdio,
 * this module proxies JSON-RPC messages to a running HTTP daemon.
 * If no daemon is running for the project, it starts one.
 *
 * The shim is transparent — the AI client thinks it's talking to a
 * stdio server; the daemon thinks it's talking to an HTTP client.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { findProjectRoot, readDaemonFile, DaemonInfo } from './daemon-discovery.js';
import { projectPorts } from './ports.js';

const DAEMON_STARTUP_TIMEOUT_MS = 15_000;
const DAEMON_POLL_INTERVAL_MS = 250;

/**
 * Run the stdio shim. Finds or starts an HTTP daemon, then proxies
 * stdin/stdout JSON-RPC to it.
 */
export async function runShim(projectPath: string): Promise<void> {
  let daemon = readDaemonFile(projectPath);

  if (!daemon) {
    daemon = await startAndWaitForDaemon(projectPath);
  }

  const baseUrl = `http://127.0.0.1:${daemon.httpPort}/mcp`;
  let sessionId: string | undefined;

  // Open SSE stream for server-initiated notifications (after first request)
  let sseStarted = false;

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (line: string) => {
    if (!line.trim()) return;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      };
      if (sessionId) {
        headers['mcp-session-id'] = sessionId;
      }

      const response = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: line,
      });

      // Capture session ID from first response
      const sid = response.headers.get('mcp-session-id');
      if (sid) sessionId = sid;

      if (!response.ok) {
        const errorBody = await response.text();
        process.stderr.write(`[shim] HTTP ${response.status}: ${errorBody}\n`);
        // Forward the error as JSON-RPC if possible
        process.stdout.write(errorBody + '\n');
        return;
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream')) {
        // SSE response — parse events and forward as JSON-RPC lines
        await handleSseResponse(response);
      } else {
        // Regular JSON response
        const body = await response.text();
        if (body.trim()) {
          process.stdout.write(body + '\n');
        }
      }

      // Start SSE listener for server notifications after first successful request
      if (sessionId && !sseStarted) {
        sseStarted = true;
        startSseListener(baseUrl, sessionId);
      }
    } catch (err) {
      process.stderr.write(`[shim] Proxy error: ${err}\n`);
    }
  });

  rl.on('close', async () => {
    // Clean up session with the daemon
    if (sessionId) {
      try {
        await fetch(baseUrl, {
          method: 'DELETE',
          headers: { 'mcp-session-id': sessionId },
        });
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  });
}

/** Parse SSE response body and write each event data as a stdout line. */
async function handleSseResponse(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data) {
          process.stdout.write(data + '\n');
        }
      }
    }
  }
}

/** Open a persistent GET SSE connection for server-initiated notifications. */
function startSseListener(baseUrl: string, sessionId: string): void {
  (async () => {
    try {
      const response = await fetch(baseUrl, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'mcp-session-id': sessionId,
        },
      });

      if (!response.ok || !response.body) return;
      await handleSseResponse(response);
    } catch {
      // SSE stream ended or failed — not fatal for the shim
    }
  })();
}

/** Start a detached daemon process and wait for it to write its daemon file. */
async function startAndWaitForDaemon(projectPath: string): Promise<DaemonInfo> {
  const ports = projectPorts(projectPath);
  const thisFile = fileURLToPath(import.meta.url);
  const indexJs = join(dirname(thisFile), 'index.js');

  process.stderr.write(`[shim] No daemon found — starting one on ports ${ports.ws}/${ports.http}\n`);

  const child = spawn(process.execPath, [
    indexJs, '--http', '--project', projectPath, '--no-force'
  ], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  // Poll for daemon file
  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
    const info = readDaemonFile(projectPath);
    if (info) return info;
  }

  throw new Error(`Daemon did not start within ${DAEMON_STARTUP_TIMEOUT_MS}ms`);
}
