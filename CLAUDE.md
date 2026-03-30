# Godot MCP — Claude Code Guidelines

## What This Is

MCP server + Godot 4.x plugin: 51 tools, 9 resources, WebSocket bridge. See [README.md](README.md) for full docs.

## Quick Reference

- **Owner**: `drunikbe/godot-mcp` (Drunik BV)
- **npm**: `@drunik/godot-mcp`
- **Build**: `cd server && npm install && npm run build`
- **Test server**: `cd server && npm test` (16 tests)
- **Test plugin**: `godot --headless --script res://tests/test_plugin.gd` (43 tests)
- **Run**: `node dist/index.js` (stdio) or `node dist/index.js --http` (daemon)

## Key Paths

- `server/src/index.ts` — entry point, CLI flags, transport modes
- `server/src/server.ts` — tool/resource registration, screenshot post-processing
- `server/src/bridge/` — WebSocket bridge + protocol types
- `server/src/tools/` — tool definitions (file, scene, script, project, asset, runtime, visualizer)
- `server/src/resources/` — resource definitions and URI routing
- `addons/godot_mcp/plugin.gd` — plugin lifecycle, auto-daemon, runtime autoload injection
- `addons/godot_mcp/mcp_client.gd` — WebSocket client with auto-reconnect
- `addons/godot_mcp/mcp_debugger_plugin.gd` — editor-to-game debugger bridge
- `addons/godot_mcp/mcp_runtime.gd` — game-side handlers (screenshots, overlays, perf stats)
- `addons/godot_mcp/commands/` — Chain of Responsibility command processors

## Architecture

```
AI Client ──(MCP)──> server.ts ──(WebSocket :6505)──> Godot plugin ──> command processors
                         │                                                     │
                    Resources (:6506 HTTP)                          DebuggerPlugin ──> running game
```

- **stdio**: one server per AI client session
- **HTTP daemon** (`--http`): persistent, multiple clients share one Godot connection
- **Runtime tools** (`game_*`, visualizer): auto-inject `__MCPRuntimeBridge__` autoload before play

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GODOT_MCP_PORT` | 6505 | WebSocket port |
| `GODOT_MCP_HTTP_PORT` | 6506 | HTTP daemon port |
| `GODOT_MCP_TIMEOUT_MS` | 30000 | Tool call timeout |
| `GODOT_MCP_IDLE_TIMEOUT_MS` | 30000 | Daemon idle shutdown |

## Adding Tools

1. Define schema in `server/src/tools/<domain>-tools.ts`
2. Register in `server/src/tools/index.ts`
3. Implement handler in `addons/godot_mcp/commands/<domain>_commands.gd`
4. Register processor in `commands/command_handler.gd`
5. Rebuild: `cd server && npm run build`

## Conventions

- **Tool results**: `{&"ok": bool}` + data or `{&"error": "msg"}`
- **Descriptions**: action-oriented, CAPS for constraints
- **Godot 4.6 compat**: don't use `:=` with dynamically-typed rhs (e.g. `Engine.get_meta()` chains) — use explicit types or `=`
- **Screenshots**: tools returning `path` field get post-processed to base64 `ImageContent` by server.ts
