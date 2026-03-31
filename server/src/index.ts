#!/usr/bin/env node
/**
 * Godot MCP Server — Entry point
 *
 * Bridges AI clients (via MCP protocol) to the Godot editor (via WebSocket).
 *
 *   AI clients ──(HTTP POST /mcp)──▶ this server ──(WebSocket)──▶ Godot plugin
 *
 * Modes:
 *   daemon (default) — HTTP server, multiple AI clients share one Godot bridge
 *   shim   (auto)    — when spawned by a stdio MCP client, proxies to a daemon
 *
 * CLI flags:
 *   --project <path>  Godot project path (enables dynamic ports + process management)
 *   --port <n>        Override HTTP port (default: auto from project path, or 6506)
 *   --no-force        Don't kill existing processes on the WebSocket/HTTP ports
 *   --http            Accepted for backwards compat (no-op, HTTP is always on)
 *
 * Environment variables:
 *   GODOT_MCP_PORT           WebSocket port for Godot (overrides hash-based port)
 *   GODOT_MCP_HTTP_PORT      HTTP port for MCP clients (overrides hash-based port)
 *   GODOT_MCP_TIMEOUT_MS     Tool call timeout in ms (default: 30000)
 *   GODOT_MCP_IDLE_TIMEOUT_MS Idle shutdown grace period in ms (default: 30000)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'child_process';
import { readFileSync } from 'node:fs';
import { GodotBridge } from './bridge/godot-bridge.js';
import { GodotProcess } from './bridge/godot-process.js';
import { createMcpServer } from './server.js';
import { toErrorMessage } from './util.js';
import { projectPorts, DEFAULT_WS_PORT, DEFAULT_HTTP_PORT } from './ports.js';
import { writeDaemonFile, removeDaemonFile, findProjectRoot } from './daemon-discovery.js';
import { runShim } from './shim.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
).version;

const cliArgs = process.argv.slice(2);
const noForce = cliArgs.includes('--no-force');

// Deprecation: --http is now a no-op (HTTP is always the transport)
if (cliArgs.includes('--http')) {
  console.error('[godot-mcp] Note: --http flag is no longer needed (HTTP is the default transport).');
}

// --project <path>: enable dynamic ports + Godot process management
const projectFlagIdx = cliArgs.indexOf('--project');
const rawProjectArg = projectFlagIdx >= 0 ? cliArgs[projectFlagIdx + 1] : undefined;
const projectPath = (rawProjectArg && !rawProjectArg.startsWith('--')) ? rawProjectArg : process.env.GODOT_MCP_PROJECT;

// --port <n>: manual HTTP port override
const portFlagIdx = cliArgs.indexOf('--port');
const cliPort = portFlagIdx >= 0 ? parseInt(cliArgs[portFlagIdx + 1], 10) : undefined;

// Compute ports: env var > CLI override > project hash > defaults
const envWs = process.env.GODOT_MCP_PORT ? parseInt(process.env.GODOT_MCP_PORT, 10) : undefined;
const envHttp = process.env.GODOT_MCP_HTTP_PORT ? parseInt(process.env.GODOT_MCP_HTTP_PORT, 10) : undefined;
const hashPorts = projectPath ? projectPorts(projectPath) : undefined;
const WEBSOCKET_PORT = envWs || hashPorts?.ws || DEFAULT_WS_PORT;
const MCP_HTTP_PORT = envHttp || cliPort || hashPorts?.http || DEFAULT_HTTP_PORT;
const TOOL_TIMEOUT = parseInt(process.env.GODOT_MCP_TIMEOUT_MS || '30000', 10);
const IDLE_SHUTDOWN_MS = parseInt(process.env.GODOT_MCP_IDLE_TIMEOUT_MS || '30000', 10);

// Detect shim mode: stdin is a pipe (spawned by MCP client) and not explicitly --http
const isStdinPipe = !process.stdin.isTTY && process.stdin.readable;
const explicitDaemon = cliArgs.includes('--http');
const shimMode = isStdinPipe && !explicitDaemon && !cliArgs.includes('--daemon');

if (shimMode) {
  // Stdio shim: proxy to HTTP daemon
  const shimProject = projectPath || findProjectRoot(process.cwd());
  if (!shimProject) {
    console.error('[godot-mcp] Cannot determine project path. Use --project <path> or run from within a Godot project directory.');
    process.exit(1);
  }
  runShim(shimProject).catch((err) => {
    console.error(`[godot-mcp] Shim error: ${err}`);
    process.exit(1);
  });
} else {
  // HTTP daemon mode
  const godotProcess = projectPath ? new GodotProcess(process.env.GODOT_PATH) : undefined;
  const godotBridge = new GodotBridge(WEBSOCKET_PORT, TOOL_TIMEOUT);
  runDaemon(godotBridge, godotProcess);
}

// ── Everything below is daemon mode only ──────────────────────────

function runDaemon(godotBridge: GodotBridge, godotProcess: GodotProcess | undefined): void {

  // ── Idle auto-shutdown ────────────────────────────────────────────
  let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;

  function checkIdleShutdown(): void {
    const hasActiveSessions = Object.keys(httpSessions).length > 0;
    if (!godotBridge.isConnected() && !hasActiveSessions) {
      if (!idleShutdownTimer) {
        console.error(`[godot-mcp] No Godot connection and no active sessions — shutting down in ${IDLE_SHUTDOWN_MS / 1000}s`);
        idleShutdownTimer = setTimeout(() => {
          if (!godotBridge.isConnected() && Object.keys(httpSessions).length === 0) {
            console.error(`[godot-mcp] Idle timeout reached — exiting`);
            shutdown();
          }
        }, IDLE_SHUTDOWN_MS);
      }
    } else if (idleShutdownTimer) {
      console.error(`[godot-mcp] Activity detected — idle shutdown cancelled`);
      clearTimeout(idleShutdownTimer);
      idleShutdownTimer = null;
    }
  }

  godotBridge.onConnectionChange((connected) => {
    const label = connected ? 'connected' : 'disconnected';
    console.error(`[godot-mcp] Godot ${label}`);
    checkIdleShutdown();
  });

  // ── Port clearing ──────────────────────────────────────────────────

  function killProcessOnPort(port: number): boolean {
    try {
      const platform = process.platform;
      let pid: string | undefined;

      if (platform === 'win32') {
        const output = execFileSync('cmd.exe', ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const match = output.trim().split('\n')[0]?.match(/\s+(\d+)\s*$/);
        pid = match?.[1];
      } else {
        const output = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        pid = output.trim().split('\n')[0];
      }

      if (pid) {
        const pidNum = parseInt(pid, 10);
        if (pidNum === process.pid) return false;
        console.error(`[godot-mcp] Killing existing process on port ${port} (PID ${pid})...`);
        process.kill(pidNum, 'SIGTERM');
        execFileSync('sleep', ['1']);
        return true;
      }
    } catch {
      // No process on port — proceed
    }
    return false;
  }

  // ── HTTP sessions ──────────────────────────────────────────────────

  interface HttpSession {
    transport: StreamableHTTPServerTransport;
    server: Server;
  }
  const httpSessions: Record<string, HttpSession> = {};

  // ── Main ───────────────────────────────────────────────────────────

  async function main() {
    console.error(`[godot-mcp] Starting v${VERSION} (HTTP daemon, WS:${WEBSOCKET_PORT} HTTP:${MCP_HTTP_PORT})...`);

    // Clear ports unless --no-force
    if (!noForce) {
      killProcessOnPort(WEBSOCKET_PORT);
      killProcessOnPort(MCP_HTTP_PORT);
    }

    // Start WebSocket server for Godot communication
    try {
      await godotBridge.start();
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        console.error(`[godot-mcp] Port ${WEBSOCKET_PORT} already in use — another instance may be running`);
        console.error(`[godot-mcp] Fix: lsof -ti :${WEBSOCKET_PORT} | xargs kill`);
      } else {
        console.error(`[godot-mcp] Failed to start WebSocket server:`, error);
      }
    }

    console.error(`[godot-mcp] Waiting for Godot editor connection on port ${WEBSOCKET_PORT}...`);

    // Auto-start Godot if --project was provided
    if (godotProcess && projectPath) {
      console.error(`[godot-mcp] Auto-starting Godot for project: ${projectPath}`);
      try {
        await godotProcess.start(godotBridge, { projectPath, headless: true });
        console.error(`[godot-mcp] Godot connected successfully`);
      } catch (error) {
        console.error(`[godot-mcp] Auto-start failed: ${toErrorMessage(error)}`);
        console.error(`[godot-mcp] Continuing — Godot can be started via start_godot tool or manually`);
      }
    }

    // ── HTTP server ──────────────────────────────────────────────
    const MCP_HOST = '127.0.0.1';
    const app = createMcpExpressApp({ host: MCP_HOST });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.post('/mcp', async (req: any, res: any) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      try {
        if (sessionId && httpSessions[sessionId]) {
          await httpSessions[sessionId].transport.handleRequest(req, res, req.body);
          return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
          const mcpServer = createMcpServer(godotBridge, VERSION, TOOL_TIMEOUT, godotProcess);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              console.error(`[godot-mcp] HTTP session initialized: ${sid}`);
              httpSessions[sid] = { transport, server: mcpServer };
              checkIdleShutdown();
            }
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && httpSessions[sid]) {
              console.error(`[godot-mcp] HTTP session closed: ${sid}`);
              const session = httpSessions[sid];
              delete httpSessions[sid];
              session.server.close();
            }
            checkIdleShutdown();
          };

          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }

        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null
        });
      } catch (error) {
        console.error(`[godot-mcp] Error handling MCP request:`, error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null
          });
        }
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.get('/mcp', async (req: any, res: any) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !httpSessions[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      await httpSessions[sessionId].transport.handleRequest(req, res);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.delete('/mcp', async (req: any, res: any) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !httpSessions[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      await httpSessions[sessionId].transport.handleRequest(req, res);
    });

    app.listen(MCP_HTTP_PORT, MCP_HOST, () => {
      console.error(`[godot-mcp] HTTP MCP server listening on http://${MCP_HOST}:${MCP_HTTP_PORT}/mcp`);
      console.error(`[godot-mcp] Multiple AI clients can connect simultaneously`);

      // Write daemon discovery file so shims and plugins can find us
      if (projectPath) {
        writeDaemonFile(projectPath, {
          pid: process.pid,
          httpPort: MCP_HTTP_PORT,
          wsPort: WEBSOCKET_PORT,
          projectPath,
        });
      }

      checkIdleShutdown();
    });
  }

  // ── Graceful shutdown ──────────────────────────────────────────────

  let isShuttingDown = false;
  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error(`[godot-mcp] Shutting down...`);

    // Clean up daemon discovery file
    if (projectPath) {
      removeDaemonFile(projectPath);
    }

    // Snapshot sessions before closing
    const sessions = Object.entries(httpSessions);
    for (const [sessionId, session] of sessions) {
      try {
        delete httpSessions[sessionId];
        await session.transport.close();
        await session.server.close();
      } catch (error) {
        console.error(`[godot-mcp] Error closing session ${sessionId}:`, error);
      }
    }

    if (godotProcess) {
      await godotProcess.stop();
    }
    godotBridge.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    // Safety net: remove daemon file even on unexpected exit
    if (projectPath) removeDaemonFile(projectPath);
  });

  main().catch((error) => {
    console.error(`[godot-mcp] Fatal error:`, error);
    process.exit(1);
  });
}
