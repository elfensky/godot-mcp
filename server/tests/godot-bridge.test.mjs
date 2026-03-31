/**
 * GodotBridge unit tests.
 *
 * Tests WebSocket server lifecycle, connection management, tool invocation,
 * timeout handling, disconnection, ping/pong, and waitForConnection.
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { GodotBridge, PROTOCOL_VERSION } from '../dist/bridge/godot-bridge.js';

const TEST_PORT = 16600;

describe('GodotBridge', () => {
  /** @type {GodotBridge} */
  let bridge;

  before(async () => {
    bridge = new GodotBridge(TEST_PORT, 2000);
    await bridge.start();
  });

  after(() => {
    bridge.stop();
  });

  describe('start/stop lifecycle', () => {
    it('reports not connected initially', () => {
      assert.equal(bridge.isConnected(), false);
    });

    it('status shows correct port and no connection', () => {
      const status = bridge.getStatus();
      assert.equal(status.port, TEST_PORT);
      assert.equal(status.connected, false);
      assert.equal(status.pendingRequests, 0);
      assert.equal(status.projectPath, undefined);
    });
  });

  describe('connection management', () => {
    /** @type {WebSocket} */
    let ws;

    afterEach(async () => {
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close();
        await sleep(200);
      }
    });

    it('accepts a Godot connection', async () => {
      ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/test-project' }));
      await sleep(200);

      assert.equal(bridge.isConnected(), true);
      const status = bridge.getStatus();
      assert.equal(status.projectPath, '/tmp/test-project');
      assert.ok(status.connectedAt instanceof Date);
    });

    it('rejects a second connection while one is active', async () => {
      ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/p1' }));
      await sleep(200);

      // Second connection should be rejected
      const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      const closeCode = await new Promise((resolve) => {
        ws2.on('close', (code) => resolve(code));
      });
      assert.equal(closeCode, 4000);
    });

    it('detects disconnection and clears state', async () => {
      ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/p' }));
      await sleep(200);
      assert.equal(bridge.isConnected(), true);

      ws.close();
      await sleep(300);

      assert.equal(bridge.isConnected(), false);
      assert.equal(bridge.getStatus().projectPath, undefined);
    });
  });

  describe('invokeTool', () => {
    it('throws when not connected', async () => {
      // Ensure no connection
      assert.equal(bridge.isConnected(), false);
      await assert.rejects(
        () => bridge.invokeTool('list_dir', { path: 'res://' }),
        { message: /not connected/ }
      );
    });

    it('sends tool_invoke and resolves with tool_result', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/p' }));

      // Handle incoming messages
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'tool_invoke') {
          ws.send(JSON.stringify({
            type: 'tool_result',
            id: msg.id,
            success: true,
            result: { ok: true, files: ['a.gd', 'b.tscn'] },
          }));
        }
      });

      await sleep(200);

      const result = await bridge.invokeTool('list_dir', { path: 'res://' });
      assert.deepEqual(result, { ok: true, files: ['a.gd', 'b.tscn'] });

      ws.close();
      await sleep(200);
    });

    it('rejects with error when tool_result has success: false', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/p' }));

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'tool_invoke') {
          ws.send(JSON.stringify({
            type: 'tool_result',
            id: msg.id,
            success: false,
            error: 'File not found',
          }));
        }
      });

      await sleep(200);

      await assert.rejects(
        () => bridge.invokeTool('read_file', { path: 'res://missing.gd' }),
        { message: 'File not found' }
      );

      ws.close();
      await sleep(200);
    });

    it('times out if no response received', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/p' }));
      await sleep(200);

      // Don't respond to tool_invoke — let it timeout
      // Bridge timeout is 2000ms
      await assert.rejects(
        () => bridge.invokeTool('slow_tool', {}),
        { message: /timed out/ }
      );

      ws.close();
      await sleep(200);
    });

    it('rejects pending requests when Godot disconnects', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/p' }));
      await sleep(200);

      // Start a tool call, then disconnect
      const toolPromise = bridge.invokeTool('list_dir', { path: 'res://' });
      ws.close();

      await assert.rejects(toolPromise, { message: /disconnected/ });
    });
  });

  describe('waitForConnection', () => {
    it('resolves when Godot connects and sends godot_ready', async () => {
      assert.equal(bridge.isConnected(), false);

      const waitPromise = bridge.waitForConnection(5000);

      // Connect after a delay
      setTimeout(async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/wait-test' }));
        });
      }, 200);

      const info = await waitPromise;
      assert.equal(info.projectPath, '/tmp/wait-test');
      assert.ok(info.connectedAt instanceof Date);

      // Cleanup
      await sleep(100);
      bridge.stop();
      bridge = new GodotBridge(TEST_PORT, 2000);
      await bridge.start();
    });

    it('rejects on timeout', async () => {
      assert.equal(bridge.isConnected(), false);
      await assert.rejects(
        () => bridge.waitForConnection(500),
        { message: /did not connect/ }
      );
    });
  });

  describe('protocol version', () => {
    /** @type {WebSocket} */
    let ws;

    afterEach(async () => {
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close();
        await sleep(200);
      }
    });

    it('accepts matching protocol version', async () => {
      ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/pv1', protocol_version: PROTOCOL_VERSION }));
      await sleep(200);

      assert.equal(bridge.isConnected(), true);
      const status = bridge.getStatus();
      assert.equal(status.projectPath, '/tmp/pv1');
    });

    it('accepts mismatched protocol version with warning (still connects)', async () => {
      ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/pv2', protocol_version: 999 }));
      await sleep(200);

      assert.equal(bridge.isConnected(), true);
      assert.equal(bridge.getStatus().projectPath, '/tmp/pv2');
    });

    it('treats missing protocol_version as version 0 (legacy)', async () => {
      ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/pv3' }));
      await sleep(200);

      assert.equal(bridge.isConnected(), true);
      assert.equal(bridge.getStatus().projectPath, '/tmp/pv3');
    });

    it('PROTOCOL_VERSION is a positive integer', () => {
      assert.equal(typeof PROTOCOL_VERSION, 'number');
      assert.ok(PROTOCOL_VERSION >= 1);
      assert.equal(PROTOCOL_VERSION, Math.floor(PROTOCOL_VERSION));
    });
  });

  describe('connectionChange callbacks', () => {
    it('fires callback on connect and disconnect', async () => {
      const events = [];
      const handler = (connected) => events.push(connected);
      bridge.onConnectionChange(handler);

      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise(resolve => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/cb-test' }));
      await sleep(200);

      ws.close();
      await sleep(300);

      bridge.offConnectionChange(handler);

      // Should have at least one true and one false
      assert.ok(events.includes(true), 'should fire connected=true');
      assert.ok(events.includes(false), 'should fire connected=false');
    });
  });
});
