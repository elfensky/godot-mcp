# Godot MCP — Claude Code Guidelines

## Project Overview

MCP server + Godot plugin that gives AI assistants (Claude, Cursor, etc.) full access to the Godot 4.x editor via WebSocket. 51 tools across 8 categories + 9 read-only resources.

## Repository Structure

- **Owner**: `drunikbe/godot-mcp` (Andrei Lavrenov / elfensky, Drunik BV)
- **npm package**: `@drunik/godot-mcp`
- Consolidates ideas from tomyud1, ee0pdt, and codingsolo godot-mcp implementations

## Key Paths

- `server/src/` — MCP server (TypeScript/Node.js)
  - `index.ts` — entry point, CLI args, transport wiring (stdio/HTTP)
  - `server.ts` — `createMcpServer()` factory, tool registration, post-processors
  - `bridge/godot-bridge.ts` — WebSocket bridge to Godot on port 6505
  - `bridge/types.ts` — WebSocket protocol + tool definition types
  - `tools/` — tool definitions with JSON schemas (per domain)
  - `resources/` — MCP Resources (read-only data: project, scenes, scripts, editor state)
- `addons/godot_mcp/` — Godot editor plugin (GDScript)
  - `plugin.gd` — plugin entry, runtime debugging lifecycle
  - `mcp_client.gd` — WebSocket client (connects to MCP server)
  - `mcp_debugger_plugin.gd` — EditorDebuggerPlugin for runtime inspection
  - `mcp_runtime.gd` — game-side autoload for runtime commands
  - `commands/` — modular command processors (Chain of Responsibility pattern)
    - `base_command_processor.gd` — abstract base class
    - `command_handler.gd` — router (iterates processors)
    - `file_commands.gd`, `scene_commands.gd`, `script_commands.gd`, etc.

## Architecture

Two transport modes:
- **stdio** (default): one MCP server per AI client
- **HTTP daemon** (`--http`): persistent process, multiple AI clients share one Godot bridge

Tool execution flow:
AI Client → MCP → `server.ts` → `godotBridge.invokeTool()` → WebSocket → Godot plugin → `command_handler.execute_command()` → specific command processor → result back

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GODOT_MCP_PORT` | 6505 | WebSocket port for Godot connection |
| `GODOT_MCP_HTTP_PORT` | 6506 | HTTP port for MCP clients (daemon mode) |
| `GODOT_MCP_TIMEOUT_MS` | 30000 | Tool call timeout in ms |
| `GODOT_MCP_IDLE_TIMEOUT_MS` | 30000 | Idle shutdown grace period |

## Build & Run

```sh
cd server && npm install && npm run build
node dist/index.js          # stdio mode
node dist/index.js --http   # daemon mode
```

## Adding New Tools

1. Create tool definitions in `server/src/tools/<domain>-tools.ts`
2. Add to `server/src/tools/index.ts`
3. Create `addons/godot_mcp/commands/<domain>_commands.gd` extending `MCPBaseCommandProcessor`
4. Register in `commands/command_handler.gd` `_initialize_processors()`

## Tool Conventions

- **Descriptions**: 1-2 sentences, action-oriented. Use CAPS for critical constraints.
- **Input validation**: Always validate before executing. Return `{&"ok": false, &"error": "..."}` on failure.
- **Result format**: All GDScript handlers return Dictionary with `&"ok": bool`.
- **Virtual methods**: Keep well-known virtuals (`_ready`, `_process`, etc.) — don't filter `_`-prefixed methods.
