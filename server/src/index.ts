#!/usr/bin/env node
/**
 * Godot MCP Server — Entry point
 *
 * Bridges AI clients (via MCP protocol) to the Godot editor (via WebSocket).
 *
 *   AI clients ──(MCP: stdio or HTTP)──▶ this server ──(WebSocket)──▶ Godot plugin
 *
 * Transport modes:
 *   stdio (default) — one server per AI client, spawned by the client
 *   --http (daemon)  — persistent process, multiple AI clients share one Godot bridge
 *
 * CLI flags:
 *   --http      Enable HTTP daemon mode (default: stdio)
 *   --no-force  Don't kill existing processes on the WebSocket/HTTP ports
 *
 * Environment variables:
 *   GODOT_MCP_PORT           WebSocket port for Godot (default: 6505)
 *   GODOT_MCP_HTTP_PORT      HTTP port for MCP clients in daemon mode (default: 6506)
 *   GODOT_MCP_TIMEOUT_MS     Tool call timeout in ms (default: 30000)
 *   GODOT_MCP_IDLE_TIMEOUT_MS Idle shutdown grace period in ms (default: 30000)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'child_process';
import { GodotBridge } from './bridge/godot-bridge.js';
import { createMcpServer } from './server.js';

const VERSION = '0.1.0';
const WEBSOCKET_PORT = parseInt(process.env.GODOT_MCP_PORT || '6505', 10);
const MCP_HTTP_PORT = parseInt(process.env.GODOT_MCP_HTTP_PORT || '6506', 10);
const TOOL_TIMEOUT = parseInt(process.env.GODOT_MCP_TIMEOUT_MS || '30000', 10);
const IDLE_SHUTDOWN_MS = parseInt(process.env.GODOT_MCP_IDLE_TIMEOUT_MS || '30000', 10);

const cliArgs = process.argv.slice(2);
const httpMode = cliArgs.includes('--http');
const noForce = cliArgs.includes('--no-force');

const godotBridge = new GodotBridge(WEBSOCKET_PORT, TOOL_TIMEOUT);

// ── Idle auto-shutdown for HTTP daemon mode ────────────────────────
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;

function checkIdleShutdown(): void {
  if (!httpMode) return;

  if (!godotBridge.isConnected()) {
    if (!idleShutdownTimer) {
      console.error(`[godot-mcp] No Godot connection — shutting down in ${IDLE_SHUTDOWN_MS / 1000}s`);
      idleShutdownTimer = setTimeout(() => {
        if (!godotBridge.isConnected()) {
          console.error(`[godot-mcp] Idle timeout reached — exiting`);
          shutdown();
        }
      }, IDLE_SHUTDOWN_MS);
    }
  } else if (idleShutdownTimer) {
    console.error(`[godot-mcp] Godot reconnected — idle shutdown cancelled`);
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
      // Safe: port is always a hardcoded number, never user input
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
  const modeLabel = httpMode ? 'HTTP daemon' : 'stdio';
  console.error(`[godot-mcp] Starting v${VERSION} (${modeLabel} mode)...`);

  // Clear ports unless --no-force
  if (!noForce) {
    killProcessOnPort(WEBSOCKET_PORT);
    if (httpMode) {
      killProcessOnPort(MCP_HTTP_PORT);
    }
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

  if (httpMode) {
    // ── HTTP daemon mode ────────────────────────────────────────
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
          const mcpServer = createMcpServer(godotBridge, VERSION);
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
      checkIdleShutdown();
    });
  } else {
    // stdio mode — single session
    const server = createMcpServer(godotBridge, VERSION);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[godot-mcp] MCP server ready (stdio)`);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────

let isShuttingDown = false;
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`[godot-mcp] Shutting down...`);

  // Snapshot sessions before closing (transport.close triggers onclose which deletes from map)
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

  godotBridge.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (!httpMode) {
  process.stdin.on('close', shutdown);
}

main().catch((error) => {
  console.error(`[godot-mcp] Fatal error:`, error);
  process.exit(1);
});
