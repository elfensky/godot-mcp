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
 * Environment variables:
 *   GODOT_MCP_PORT           WebSocket port for Godot (default: 6505)
 *   GODOT_MCP_HTTP_PORT      HTTP port for MCP clients in daemon mode (default: 6506)
 *   GODOT_MCP_TIMEOUT_MS     Tool call timeout in ms (default: 30000)
 *   GODOT_MCP_IDLE_TIMEOUT_MS Idle shutdown grace period in ms (default: 30000)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GodotBridge } from './bridge/godot-bridge.js';
import { createMcpServer } from './server.js';

const VERSION = '0.1.0';
const WEBSOCKET_PORT = parseInt(process.env.GODOT_MCP_PORT || '6505', 10);
const TOOL_TIMEOUT = parseInt(process.env.GODOT_MCP_TIMEOUT_MS || '30000', 10);

const cliArgs = process.argv.slice(2);
const httpMode = cliArgs.includes('--http');

const godotBridge = new GodotBridge(WEBSOCKET_PORT, TOOL_TIMEOUT);

godotBridge.onConnectionChange((connected) => {
  const label = connected ? 'connected' : 'disconnected';
  console.error(`[godot-mcp] Godot ${label}`);
});

async function main() {
  const modeLabel = httpMode ? 'HTTP daemon' : 'stdio';
  console.error(`[godot-mcp] Starting v${VERSION} (${modeLabel} mode)...`);

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
    // HTTP daemon mode will be implemented in Phase 5
    console.error(`[godot-mcp] HTTP daemon mode not yet implemented — use stdio mode for now`);
    process.exit(1);
  } else {
    // stdio mode — single session
    const server = createMcpServer(godotBridge, VERSION);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[godot-mcp] MCP server ready (stdio)`);
  }
}

// Graceful shutdown
let isShuttingDown = false;
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`[godot-mcp] Shutting down...`);
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
