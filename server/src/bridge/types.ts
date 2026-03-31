/**
 * Type definitions for Godot MCP WebSocket protocol and tool system.
 */

// ── Tool definition ──────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
}

export interface PropertySchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  default?: unknown;
  enum?: string[];
  items?: PropertySchema;
}

// ── WebSocket messages ───────────────────────────────────────────────

export interface ToolInvokeMessage {
  type: 'tool_invoke';
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessage {
  type: 'tool_result';
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
}

export interface GodotReadyMessage {
  type: 'godot_ready';
  project_path: string;
  protocol_version?: number;
}

export type WebSocketMessage =
  | ToolInvokeMessage
  | ToolResultMessage
  | PingMessage
  | PongMessage
  | GodotReadyMessage;
