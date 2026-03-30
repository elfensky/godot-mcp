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
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'node:fs';

import { GodotBridge } from './bridge/godot-bridge.js';
import { allTools, toolExists } from './tools/index.js';

const SERVER_NAME = '@drunik/godot-mcp';

export function createMcpServer(
  godotBridge: GodotBridge,
  version: string
): Server {
  const server = new Server(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {} } }
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

    // Invoke tool on Godot
    try {
      const result = await godotBridge.invokeTool(name, toolArgs);

      // Post-process game_screenshot: read PNG from disk, return as base64 ImageContent
      if (name === 'game_screenshot' && result && typeof result === 'object' && 'path' in (result as Record<string, unknown>)) {
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
                  text: JSON.stringify({
                    ok: true,
                    width: screenshotResult.width,
                    height: screenshotResult.height
                  }, null, 2)
                }
              ]
            };
          } catch (readError) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  error: `Failed to read screenshot: ${readError instanceof Error ? readError.message : String(readError)}`,
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: errorMessage,
            tool: name,
            args: toolArgs,
            hint: 'The tool call was sent to Godot but failed. Check Godot editor for details.'
          }, null, 2)
        }],
        isError: true
      };
    }
  });

  return server;
}
