/**
 * MCP Server factory — creates and configures a Server instance.
 *
 * Registers all tool handlers and routes tool calls to Godot via the bridge.
 * In HTTP daemon mode, each client session gets its own Server instance sharing
 * the same GodotBridge. In stdio mode, only one Server is created.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'node:fs';

import { GodotBridge } from './bridge/godot-bridge.js';
import { GodotProcess } from './bridge/godot-process.js';
import { toErrorMessage } from './util.js';
import { allTools, toolExists } from './tools/index.js';
import { lifecycleToolNames } from './tools/lifecycle-tools.js';
import { assertToolNames, handleAssertTool } from './tools/assert-tools.js';
import { staticResources, resourceTemplates, readResource } from './resources/index.js';

const SERVER_NAME = '@elfensky/godot-mcp';

export function createMcpServer(
  godotBridge: GodotBridge,
  version: string,
  toolTimeoutMs: number,
  godotProcess?: GodotProcess
): Server {
  const server = new Server(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ── List tools ───────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const statusTool = {
      name: 'get_godot_status',
      description: 'Check if Godot editor is connected to the MCP server.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: []
      }
    };

    return {
      tools: [
        statusTool,
        ...allTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      ]
    };
  });

  // ── Call tool ────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args || {}) as Record<string, unknown>;

    // Built-in status tool
    if (name === 'get_godot_status') {
      const status = godotBridge.getStatus();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected: status.connected,
            server_version: version,
            websocket_port: status.port,
            mode: status.connected ? 'live' : 'waiting',
            project_path: status.projectPath || null,
            connected_at: status.connectedAt?.toISOString() || null,
            pending_requests: status.pendingRequests,
            message: status.connected
              ? `Godot is connected${status.projectPath ? ` (${status.projectPath})` : ''}. Tools will execute in the Godot editor.`
              : 'Godot is not connected. Open a Godot project with the MCP plugin enabled to connect.'
          }, null, 2)
        }]
      };
    }

    // Validate tool exists
    if (!toolExists(name)) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${name}. Available tools: ${allTools.map(t => t.name).join(', ')}`
      );
    }

    // Lifecycle tools work before Godot is connected
    if (lifecycleToolNames.has(name)) {
      try {
        const result = await handleLifecycleTool(name, toolArgs, godotBridge, godotProcess);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: toErrorMessage(error) }, null, 2) }], isError: true };
      }
    }

    // Require Godot connection
    if (!godotBridge.isConnected()) {
      const wsPort = godotBridge.getStatus().port;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Godot editor is not connected',
            tool: name,
            hint: `Open a Godot project with the MCP plugin enabled. The plugin will auto-connect on port ${wsPort}.`
          }, null, 2)
        }],
        isError: true
      };
    }

    // Assert meta-tools: handled in TypeScript, call bridge internally
    if (assertToolNames.has(name)) {
      try {
        const result = await handleAssertTool(name, toolArgs, godotBridge, toolTimeoutMs);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: toErrorMessage(error) }, null, 2) }], isError: true };
      }
    }

    // Invoke tool on Godot
    try {
      const result = await godotBridge.invokeTool(name, toolArgs);

      // Post-process tools that return screenshots: read PNG from disk, return as base64 ImageContent
      const screenshotTools = ['game_screenshot', 'debug_draw_overlay', 'highlight_node'];
      if (screenshotTools.includes(name) && result && typeof result === 'object' && 'path' in (result as Record<string, unknown>)) {
        const screenshotResult = result as Record<string, unknown>;
        const filePath = screenshotResult.path as string;

        // Retry once after 500ms if file not found (game may still be writing)
        let fileExists = existsSync(filePath);
        if (!fileExists) {
          await new Promise(resolve => setTimeout(resolve, 500));
          fileExists = existsSync(filePath);
        }

        if (fileExists) {
          try {
            const imageData = readFileSync(filePath);
            const base64 = imageData.toString('base64');
            return {
              content: [
                { type: 'image' as const, data: base64, mimeType: 'image/png' },
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    Object.fromEntries(
                      Object.entries(screenshotResult).filter(([k]) => k !== 'path')
                    ),
                    null, 2
                  )
                }
              ]
            };
          } catch (readError) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  error: `Failed to read screenshot: ${toErrorMessage(readError)}`,
                  path: filePath
                }, null, 2)
              }],
              isError: true
            };
          }
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: toErrorMessage(error),
            tool: name,
            args: toolArgs,
            hint: 'The tool call was sent to Godot but failed. Check Godot editor for details.'
          }, null, 2)
        }],
        isError: true
      };
    }
  });

  // ── List resources ────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: staticResources.map(r => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType
      }))
    };
  });

  // ── List resource templates ───────────────────────────────────────

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: resourceTemplates.map(r => ({
        uriTemplate: r.uriTemplate,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType
      }))
    };
  });

  // ── Read resource ─────────────────────────────────────────────────

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    try {
      const { content, mimeType } = await readResource(uri, godotBridge);
      return {
        contents: [{
          uri,
          mimeType,
          text: content
        }]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Failed to read resource ${uri}: ${toErrorMessage(error)}`
      );
    }
  });

  return server;
}

// ── Lifecycle tool handler ──────────────────────────────────────────

async function handleLifecycleTool(
  name: string,
  args: Record<string, unknown>,
  bridge: GodotBridge,
  godotProcess?: GodotProcess
): Promise<unknown> {
  switch (name) {
    case 'start_godot': {
      if (bridge.isConnected()) {
        const status = bridge.getStatus();
        return {
          ok: true,
          already_connected: true,
          project_path: status.projectPath || null,
          message: 'Godot is already connected. Use stop_godot first to restart.'
        };
      }
      if (!godotProcess) {
        return {
          ok: false,
          error: 'Process management not available. Start the server with --project <path> to enable, or start Godot manually.'
        };
      }
      const projectPath = args.project_path as string;
      if (!projectPath) {
        return { ok: false, error: 'project_path is required.' };
      }
      await godotProcess.start(bridge, {
        projectPath,
        headless: (args.headless as boolean) ?? true,
        extraArgs: (args.extra_args as string[]) ?? [],
      });
      const status = godotProcess.getStatus(bridge);
      return {
        ok: true,
        pid: status.pid,
        connected: status.connected,
        message: `Godot started (PID ${status.pid}) and connected.`
      };
    }

    case 'stop_godot': {
      if (!godotProcess) {
        return { ok: false, error: 'Process management not available — Godot was started externally.' };
      }
      await godotProcess.stop();
      return { ok: true, message: 'Godot process stopped.' };
    }

    case 'godot_process_status': {
      if (!godotProcess) {
        // Still useful: show bridge connection status even without managed process
        const bridgeStatus = bridge.getStatus();
        return {
          managed: false,
          running: false,
          connected: bridgeStatus.connected,
          project_path: bridgeStatus.projectPath || null,
          message: 'No managed process — Godot was started externally or not yet started.'
        };
      }
      const status = godotProcess.getStatus(bridge);
      return {
        managed: true,
        ...status,
        message: status.running
          ? `Godot running (PID ${status.pid}, uptime ${Math.round((status.uptimeMs || 0) / 1000)}s)`
          : `Godot not running (last exit code: ${status.exitCode})`
      };
    }

    default:
      return { ok: false, error: `Unknown lifecycle tool: ${name}` };
  }
}
