# Godot MCP — Claude Code Guidelines

MCP server + Godot 4.x plugin: 61 tools, 9 resources, WebSocket bridge. See [README.md](README.md) for full docs.

## Commands

| Task | Command | Make target |
|------|---------|-------------|
| Build | `cd server && npm install && npm run build` | `make build` |
| Test all | — | `make test` |
| Test server | `cd server && npm test` | `make test-unit` |
| Test E2E | `cd server && npm run test:e2e` (requires daemon + headless Godot) | `make test-e2e` |
| Test plugin | `godot --headless --script res://tests/test_plugin.gd` | `make test-plugin` |
| Run stdio | `node dist/index.js --project <path>` | — |
| Run daemon | `node dist/index.js --daemon` | — |
| Clean | `rm -rf server/dist server/node_modules` | `make clean` |

## Rules

### Verification

Report outcomes faithfully. Never claim "all tests pass" when output shows failures. Never suppress failing checks to manufacture a green result. After edits, run test/typecheck/lint commands before reporting success.

### File & Function Size

- Files should stay under ~500–800 LOC. Files over 1000 LOC must be split before major changes.
- Functions should stay under ~100 lines. Functions over 200 lines must be refactored before modification.
- Prioritize cohesion (one responsibility per file) and clear boundaries over compactness.
- **Known oversize files**: `project_commands.gd` (1102), `scene_commands.gd` (1078) — split these before adding new commands to them.

### Reading & Searching

- Read files over 500 lines in chunks using offset/limit. Don't assume a single read captured the entire file.
- When renaming or changing a function/type/variable, search for: direct calls, type references, string literals, re-exports, barrel files, and test mocks. Don't assume a single grep found everything.

### Godot Conventions

- **Tool results**: `{&"ok": bool}` + data or `{&"error": "msg"}`
- **Godot 4.6 compat**: don't use `:=` with dynamically-typed rhs (e.g. `Engine.get_meta()` chains) — use explicit types or `=`
- **Screenshots**: tools returning `path` field get post-processed to base64 `ImageContent` by server.ts
- **Tool descriptions**: action-oriented, CAPS for constraints

## Architecture

```
AI (stdio) → In-Process Server → WebSocket → Godot plugin
AI (HTTP)  → Daemon (HTTP)     → WebSocket → Godot plugin
                                              ├─ Commands
                                              └─ DebuggerPlugin → Running game
```

- **Stdio mode** (default): in-process MCP server, Godot auto-started in background
- **HTTP daemon** (`--daemon`): persistent process, multiple AI clients share one Godot connection
- **Dynamic ports**: FNV-1a hash of project path → unique port pair (range 6505–8504)
- **Runtime tools** (`game_*`, visualizer): auto-inject `__MCPRuntimeBridge__` autoload before play

## Key Paths

**Server (TypeScript)**:
- `server/src/index.ts` — entry point, CLI flags, stdio/daemon routing
- `server/src/server.ts` — tool/resource registration, screenshot post-processing
- `server/src/ports.ts` — deterministic port assignment
- `server/src/daemon-discovery.ts` — `.godot/mcp-daemon.json` lifecycle
- `server/src/bridge/` — WebSocket bridge + protocol types
- `server/src/tools/` — tool definitions (file, scene, script, project, asset, runtime, visualizer)
- `server/src/resources/` — resource definitions and URI routing

**Plugin (GDScript)**:
- `addons/godot_mcp/plugin.gd` — plugin lifecycle, auto-daemon, runtime autoload injection
- `addons/godot_mcp/mcp_client.gd` — WebSocket client with auto-reconnect
- `addons/godot_mcp/mcp_debugger_plugin.gd` — editor-to-game debugger bridge
- `addons/godot_mcp/mcp_runtime.gd` — game-side handlers (screenshots, overlays, perf stats)
- `addons/godot_mcp/commands/` — Chain of Responsibility command processors

## Adding Tools

1. Define schema in `server/src/tools/<domain>-tools.ts`
2. Register in `server/src/tools/index.ts`
3. Implement handler in `addons/godot_mcp/commands/<domain>_commands.gd`
4. Register processor in `commands/command_handler.gd`
5. Update expected tool list in `server/tests/tool-manifest.test.mjs`
6. Rebuild: `cd server && npm run build`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GODOT_MCP_PORT` | auto | WebSocket port override |
| `GODOT_MCP_HTTP_PORT` | auto | HTTP port override |
| `GODOT_MCP_TIMEOUT_MS` | 30000 | Tool call timeout |
| `GODOT_MCP_IDLE_TIMEOUT_MS` | 30000 | Daemon idle shutdown |
| `GODOT_MCP_SPAWNED_BY_DAEMON` | — | Set by daemon to prevent plugin recursion |

## Self-Recovery

If MCP tools are unavailable:
1. `cd server && npm run build`
2. `which godot-mcp` should point to `server/dist/index.js` (`npm link` from `server/` if not)
3. `echo '{}' | node server/dist/index.js --project "$(pwd)"` — should not hang

If only Godot disconnected, use the `start_godot` MCP tool. Fallback testing without MCP: `cd server && npm test` (unit) and `godot --headless --script res://tests/test_plugin.gd` (plugin).