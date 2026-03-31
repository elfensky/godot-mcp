/**
 * MCP Server Integration Tests
 *
 * Tests the server's HTTP endpoint, tool listing, resource listing,
 * and WebSocket bridge using Node's built-in test runner.
 *
 * Run: node --test server/tests/server.test.mjs
 * (from the repo root, after `cd server && npm run build`)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const MCP_HTTP_PORT = 16506; // Use non-default ports for testing
const WS_PORT = 16505;

let serverProcess;

async function mcpRequest(method, params = {}, sessionId = null) {
  const id = Math.floor(Math.random() * 100000);
  const body = { jsonrpc: '2.0', id, method, params };
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`http://127.0.0.1:${MCP_HTTP_PORT}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  // Parse SSE response
  const dataLine = text.split('\n').find(l => l.startsWith('data:'));
  if (dataLine) {
    return JSON.parse(dataLine.slice(5));
  }
  // Try direct JSON
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

async function initSession() {
  const res = await fetch(`http://127.0.0.1:${MCP_HTTP_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-runner', version: '1.0' },
      },
    }),
  });

  const sessionId = res.headers.get('mcp-session-id');
  const text = await res.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data:'));
  const data = dataLine ? JSON.parse(dataLine.slice(5)) : JSON.parse(text);

  // Send initialized notification
  await fetch(`http://127.0.0.1:${MCP_HTTP_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  return { sessionId, initResponse: data };
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('MCP Server', () => {
  before(async () => {
    serverProcess = spawn('node', ['dist/index.js', '--daemon', '--no-force'], {
      cwd: new URL('../', import.meta.url).pathname,
      env: {
        ...process.env,
        GODOT_MCP_PORT: String(WS_PORT),
        GODOT_MCP_HTTP_PORT: String(MCP_HTTP_PORT),
        GODOT_MCP_IDLE_TIMEOUT_MS: '60000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for server to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
      serverProcess.stderr.on('data', (data) => {
        if (data.toString().includes('HTTP MCP server listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProcess.on('error', reject);
    });
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  });

  describe('Initialize', () => {
    it('returns correct protocol version and capabilities', async () => {
      const { initResponse } = await initSession();
      const result = initResponse.result;
      assert.equal(result.protocolVersion, '2025-03-26');
      assert.equal(result.serverInfo.name, '@drunik/godot-mcp');
      assert.ok(result.capabilities.tools, 'should have tools capability');
      assert.ok(result.capabilities.resources, 'should have resources capability');
    });
  });

  describe('Tools', () => {
    let sessionId;
    before(async () => {
      ({ sessionId } = await initSession());
    });

    it('lists all 61 tools', async () => {
      const res = await mcpRequest('tools/list', {}, sessionId);
      const tools = res.result.tools;
      assert.equal(tools.length, 61, `Expected 61 tools, got ${tools.length}`);
    });

    it('includes get_godot_status built-in tool', async () => {
      const res = await mcpRequest('tools/list', {}, sessionId);
      const names = res.result.tools.map(t => t.name);
      assert.ok(names.includes('get_godot_status'));
    });

    it('includes all tool categories', async () => {
      const res = await mcpRequest('tools/list', {}, sessionId);
      const names = new Set(res.result.tools.map(t => t.name));

      const categories = {
        file: ['list_dir', 'read_file', 'search_project', 'create_script'],
        scene: ['create_scene', 'read_scene', 'add_node'],
        script: ['edit_script', 'validate_script', 'list_scripts'],
        project: ['get_project_settings', 'run_scene', 'classdb_query'],
        asset: ['generate_2d_asset'],
        runtime: ['game_screenshot', 'game_scene_tree'],
        visualizer: ['debug_draw_overlay', 'highlight_node', 'performance_stats'],
        lifecycle: ['start_godot', 'stop_godot', 'godot_process_status'],
        eval: ['eval_expression', 'eval_editor_expression'],
        input: ['send_input_action', 'send_key_event'],
        assert: ['assert_property', 'assert_node_exists', 'wait_for_condition'],
      };

      for (const [cat, tools] of Object.entries(categories)) {
        for (const tool of tools) {
          assert.ok(names.has(tool), `Missing ${cat} tool: ${tool}`);
        }
      }
    });

    it('all tools have descriptions and schemas', async () => {
      const res = await mcpRequest('tools/list', {}, sessionId);
      for (const tool of res.result.tools) {
        assert.ok(tool.description, `${tool.name} missing description`);
        assert.ok(tool.inputSchema, `${tool.name} missing inputSchema`);
        assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema type should be object`);
      }
    });

    it('get_godot_status works without Godot', async () => {
      const res = await mcpRequest('tools/call',
        { name: 'get_godot_status', arguments: {} }, sessionId);
      const status = JSON.parse(res.result.content[0].text);
      assert.equal(status.connected, false);
      assert.equal(status.mode, 'waiting');
      assert.equal(status.websocket_port, WS_PORT);
    });

    it('tools requiring Godot return graceful error', async () => {
      const res = await mcpRequest('tools/call',
        { name: 'list_dir', arguments: { path: 'res://' } }, sessionId);
      assert.equal(res.result.isError, true);
      const body = JSON.parse(res.result.content[0].text);
      assert.ok(body.error.includes('not connected'));
      assert.ok(body.hint);
    });

    it('lifecycle tools work without Godot connection', async () => {
      const res = await mcpRequest('tools/call',
        { name: 'godot_process_status', arguments: {} }, sessionId);
      assert.equal(res.result.isError, undefined);
      const body = JSON.parse(res.result.content[0].text);
      assert.equal(body.connected, false);
      assert.equal(body.managed, false);
    });

    it('unknown tool returns proper MCP error', async () => {
      const res = await mcpRequest('tools/call',
        { name: 'nonexistent_tool', arguments: {} }, sessionId);
      assert.ok(res.error, 'Should have error');
      assert.equal(res.error.code, -32601);
    });
  });

  describe('Resources', () => {
    let sessionId;
    before(async () => {
      ({ sessionId } = await initSession());
    });

    it('lists 7 static resources', async () => {
      const res = await mcpRequest('resources/list', {}, sessionId);
      assert.equal(res.result.resources.length, 7);
    });

    it('lists 2 resource templates', async () => {
      const res = await mcpRequest('resources/templates/list', {}, sessionId);
      assert.equal(res.result.resourceTemplates.length, 2);
    });

    it('has expected resource URIs', async () => {
      const res = await mcpRequest('resources/list', {}, sessionId);
      const uris = res.result.resources.map(r => r.uri);
      assert.ok(uris.includes('godot://project/settings'));
      assert.ok(uris.includes('godot://scenes'));
      assert.ok(uris.includes('godot://scripts'));
      assert.ok(uris.includes('godot://editor/errors'));
    });

    it('has expected resource templates', async () => {
      const res = await mcpRequest('resources/templates/list', {}, sessionId);
      const templates = res.result.resourceTemplates.map(r => r.uriTemplate);
      assert.ok(templates.includes('godot://scene/{path}'));
      assert.ok(templates.includes('godot://file/{path}'));
    });

    it('reading resource without Godot returns error', async () => {
      const res = await mcpRequest('resources/read',
        { uri: 'godot://project/settings' }, sessionId);
      assert.ok(res.error);
      assert.ok(res.error.message.includes('not connected'));
    });
  });

  describe('WebSocket Bridge', () => {
    it('accepts Godot connection and receives godot_ready', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);

      const connected = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
        ws.on('open', () => { clearTimeout(timeout); resolve(true); });
        ws.on('error', reject);
      });
      assert.ok(connected);

      // Send godot_ready
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/test' }));

      // Wait for ping
      const msg = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No ping received')), 15000);
        ws.on('message', (data) => {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'ping') {
            clearTimeout(timeout);
            resolve(parsed);
          }
        });
      });
      assert.equal(msg.type, 'ping');

      // Verify status now shows connected
      const { sessionId } = await initSession();
      const res = await mcpRequest('tools/call',
        { name: 'get_godot_status', arguments: {} }, sessionId);
      const status = JSON.parse(res.result.content[0].text);
      assert.equal(status.connected, true);
      assert.equal(status.project_path, '/tmp/test');

      ws.close();
      await sleep(500);
    });

    it('routes tool calls through WebSocket to Godot', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      await new Promise((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'godot_ready', project_path: '/tmp/test' }));

      // Set up tool response handler
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'tool_invoke') {
          ws.send(JSON.stringify({
            type: 'tool_result',
            id: msg.id,
            success: true,
            result: { ok: true, files: ['main.tscn', 'player.gd'] },
          }));
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      });

      await sleep(200);

      const { sessionId } = await initSession();
      const res = await mcpRequest('tools/call',
        { name: 'list_dir', arguments: { path: 'res://' } }, sessionId);

      const content = JSON.parse(res.result.content[0].text);
      assert.ok(content.ok);
      assert.deepEqual(content.files, ['main.tscn', 'player.gd']);

      ws.close();
      await sleep(500);
    });
  });

  describe('Sessions', () => {
    it('supports multiple concurrent sessions', async () => {
      const session1 = await initSession();
      const session2 = await initSession();
      assert.notEqual(session1.sessionId, session2.sessionId);

      // Both sessions should work independently
      const res1 = await mcpRequest('tools/call',
        { name: 'get_godot_status', arguments: {} }, session1.sessionId);
      const res2 = await mcpRequest('tools/call',
        { name: 'get_godot_status', arguments: {} }, session2.sessionId);

      assert.ok(res1.result);
      assert.ok(res2.result);
    });
  });
});
