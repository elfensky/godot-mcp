/**
 * GodotBridge — WebSocket server for communication with Godot plugin.
 *
 * Handles:
 * - WebSocket server on configurable port (default 6505)
 * - Connection management with Godot plugin
 * - Tool invocation requests and response tracking
 * - Timeouts and error handling
 * - Ping/pong keepalive
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import type {
  ToolInvokeMessage,
  ToolResultMessage,
  WebSocketMessage
} from './types.js';

const DEFAULT_PORT = 6505;
const DEFAULT_TIMEOUT = 30000;
const PING_INTERVAL = 10000;

export const PROTOCOL_VERSION = 1;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  toolName: string;
  startTime: number;
}

interface GodotInfo {
  projectPath?: string;
  connectedAt: Date;
  protocolVersion?: number;
}

type ConnectionCallback = (connected: boolean, info?: GodotInfo) => void;

export class GodotBridge {
  private wss: WebSocketServer | null = null;
  private godotConnection: WebSocket | null = null;
  private godotInfo: GodotInfo | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;
  private connectionCallbacks: Set<ConnectionCallback> = new Set();

  private port: number;
  private timeout: number;

  constructor(port: number = DEFAULT_PORT, timeout: number = DEFAULT_TIMEOUT) {
    this.port = port;
    this.timeout = timeout;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });

        this.wss.on('connection', (ws, req) => {
          this.handleConnection(ws, req);
        });

        this.wss.on('error', (error) => {
          this.log('error', `WebSocket server error: ${error.message}`);
          reject(error);
        });

        this.wss.on('listening', () => {
          this.log('info', `WebSocket server listening on port ${this.port}`);
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Server shutting down'));
    }
    this.pendingRequests.clear();

    if (this.godotConnection) {
      this.godotConnection.close();
      this.godotConnection = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.log('info', 'WebSocket server stopped');
  }

  private handleConnection(ws: WebSocket, _req: unknown): void {
    if (this.godotConnection) {
      this.log('warn', 'Rejecting connection — Godot already connected');
      ws.close(4000, 'Another Godot instance is already connected');
      return;
    }

    this.godotConnection = ws;
    this.godotInfo = { connectedAt: new Date() };
    this.log('info', 'Godot plugin connected');

    this.pingInterval = setInterval(() => {
      if (this.godotConnection?.readyState === WebSocket.OPEN) {
        this.sendMessage({ type: 'ping' });
      }
    }, PING_INTERVAL);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as WebSocketMessage;
        this.handleMessage(message);
      } catch (error) {
        this.log('error', `Failed to parse message: ${error}`);
      }
    });

    ws.on('close', (code, reason) => {
      this.log('info', `Godot disconnected: ${code} - ${reason.toString()}`);
      this.handleDisconnection();
    });

    ws.on('error', (error) => {
      this.log('error', `WebSocket error: ${error.message}`);
    });

    this.notifyConnectionChange(true);
  }

  private handleDisconnection(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    this.godotConnection = null;
    const info = this.godotInfo;
    this.godotInfo = null;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Godot disconnected'));
    }
    this.pendingRequests.clear();

    this.notifyConnectionChange(false, info || undefined);
  }

  private handleMessage(message: WebSocketMessage): void {
    switch (message.type) {
      case 'tool_result':
        this.handleToolResult(message);
        break;
      case 'pong':
        break;
      case 'godot_ready':
        if (this.godotInfo) {
          this.godotInfo.projectPath = message.project_path;
          const remoteVersion = message.protocol_version ?? 0;
          this.godotInfo.protocolVersion = remoteVersion;
          if (remoteVersion !== PROTOCOL_VERSION) {
            this.log('warn', `Protocol version mismatch: server=${PROTOCOL_VERSION}, plugin=${remoteVersion}`);
          }
          this.log('info', `Godot project: ${message.project_path} (protocol v${remoteVersion})`);
          // Notify again with project path populated — waitForConnection resolves here
          this.notifyConnectionChange(true, this.godotInfo);
        }
        break;
      default:
        this.log('warn', `Unknown message type: ${(message as { type: string }).type}`);
    }
  }

  private handleToolResult(message: ToolResultMessage): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      this.log('warn', `Received result for unknown request: ${message.id}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.id);

    const duration = Date.now() - pending.startTime;
    this.log('debug', `Tool ${pending.toolName} completed in ${duration}ms`);

    if (message.success) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || 'Tool execution failed'));
    }
  }

  async invokeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected()) {
      throw new Error('Godot is not connected');
    }

    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Tool ${toolName} timed out after ${this.timeout}ms`));
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout,
        toolName,
        startTime: Date.now()
      });

      const message: ToolInvokeMessage = {
        type: 'tool_invoke',
        id,
        tool: toolName,
        args
      };

      this.sendMessage(message);
      this.log('debug', `Invoking tool: ${toolName} (${id})`);
    });
  }

  private sendMessage(message: WebSocketMessage | ToolInvokeMessage): void {
    if (this.godotConnection?.readyState === WebSocket.OPEN) {
      this.godotConnection.send(JSON.stringify(message));
    }
  }

  isConnected(): boolean {
    return this.godotConnection?.readyState === WebSocket.OPEN;
  }

  getStatus(): {
    connected: boolean;
    projectPath?: string;
    connectedAt?: Date;
    pendingRequests: number;
    port: number;
  } {
    return {
      connected: this.isConnected(),
      projectPath: this.godotInfo?.projectPath,
      connectedAt: this.godotInfo?.connectedAt,
      pendingRequests: this.pendingRequests.size,
      port: this.port
    };
  }

  onConnectionChange(callback: ConnectionCallback): void {
    this.connectionCallbacks.add(callback);
  }

  offConnectionChange(callback: ConnectionCallback): void {
    this.connectionCallbacks.delete(callback);
  }

  waitForConnection(timeoutMs: number = 30000): Promise<GodotInfo> {
    // Resolve only after godot_ready (projectPath populated), not just TCP connect
    if (this.isConnected() && this.godotInfo?.projectPath) {
      return Promise.resolve(this.godotInfo);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.offConnectionChange(handler);
        reject(new Error(`Godot did not connect within ${timeoutMs}ms`));
      }, timeoutMs);

      const handler: ConnectionCallback = (connected, info) => {
        if (connected && info?.projectPath) {
          clearTimeout(timer);
          this.offConnectionChange(handler);
          resolve(info);
        }
      };

      this.connectionCallbacks.add(handler);
    });
  }

  private notifyConnectionChange(connected: boolean, info?: GodotInfo): void {
    for (const callback of this.connectionCallbacks) {
      try {
        callback(connected, info);
      } catch (error) {
        this.log('error', `Connection callback error: ${error}`);
      }
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [GodotBridge] [${level.toUpperCase()}] ${message}`);
  }
}
