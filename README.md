# Godot MCP

MCP (Model Context Protocol) server and Godot 4.x editor plugin that gives AI assistants full access to the Godot editor. Build, inspect, and debug Godot games through natural language.

Works with any MCP-compatible AI client: Claude Code, Claude Desktop, Cursor, Windsurf, and others.

## How It Works

```
AI Client (stdio) ──> shim ──┐
                              ├──(HTTP)──> daemon ──(WebSocket)──> Godot Plugin
AI Client (HTTP)  ────────────┘                                       |
                                                                Command execution
                                                                Scene manipulation
                                                                Runtime debugging
```

The system has two layers:

1. **Node.js MCP server** — HTTP daemon that speaks the MCP protocol to AI clients and translates tool calls into WebSocket messages
2. **GDScript editor plugin** — runs inside Godot, receives commands via WebSocket, executes them using the editor and engine APIs

The server runs as a persistent HTTP daemon. Multiple AI clients can connect simultaneously, sharing one Godot connection. Stdio-only MCP clients (like Claude Desktop) are handled by a thin shim that auto-starts the daemon and proxies messages.

Each Godot project gets its own daemon on a unique port pair (derived from the project path), so multiple projects can run in parallel without conflicts.

## Features

### 61 Tools Across 11 Categories

**File Tools** (4) — Browse and search the project filesystem
- `list_dir` `read_file` `search_project` `create_script`

**Scene Tools** (11) — Create and modify .tscn scene files
- `create_scene` `read_scene` `add_node` `remove_node` `modify_node_property` `rename_node` `move_node` `attach_script` `detach_script` `set_collision_shape` `set_sprite_texture`

**Script Tools** (8) — Edit GDScript, evaluate expressions
- `edit_script` `validate_script` `list_scripts` `create_folder` `delete_file` `rename_file` `eval_expression` `eval_editor_expression`

**Project Tools** (20) — Query and configure project settings, run scenes
- `get_project_settings` `get_input_map` `get_collision_layers` `get_node_properties` `get_console_log` `get_errors` `get_debugger_errors` `clear_console_log` `open_in_godot` `scene_tree_dump` `list_settings` `update_project_settings` `configure_input_map` `rescan_filesystem` `run_scene` `stop_scene` `is_playing` `classdb_query` `setup_autoload` `eval_editor_expression`

**Asset Tools** (1) — Generate 2D sprites from SVG
- `generate_2d_asset`

**Runtime Tools** (6) — Inspect and interact with the running game
- `game_screenshot` `game_scene_tree` `game_get_properties` `game_get_property` `send_input_action` `send_key_event`

**Visualizer Tools** (5) — Debug overlays and performance monitoring
- `debug_draw_overlay` `clear_debug_overlay` `highlight_node` `watch_property` `performance_stats`

**Lifecycle Tools** (3) — Manage the Godot process
- `start_godot` `stop_godot` `godot_process_status`

**Assert Tools** (3) — Automated testing meta-tools
- `assert_property` `assert_node_exists` `wait_for_condition`

**Status** (1) — Built-in connection check
- `get_godot_status`

### 9 Read-Only Resources

Resources let AI clients pull project context without side effects:

| URI | What it returns |
|-----|-----------------|
| `godot://project/settings` | Main scene, window size, physics, rendering config |
| `godot://project/input-map` | All input actions and their bindings |
| `godot://scenes` | Every .tscn file in the project |
| `godot://scripts` | Every .gd file with metadata |
| `godot://editor/scene-tree` | Node hierarchy of the currently edited scene |
| `godot://editor/errors` | Latest errors and warnings |
| `godot://editor/console` | Latest console output |
| `godot://scene/{path}` | Parsed structure of a specific scene file |
| `godot://file/{path}` | Contents of any project file |

### Runtime Debugging

When the AI calls runtime tools (`game_*`, visualizer tools), the plugin automatically:

1. Injects a `__MCPRuntimeBridge__` autoload into the project
2. Launches the scene with the debugger bridge active
3. Routes commands through Godot's `EditorDebuggerPlugin` message channel
4. Cleans up the autoload when the scene stops

This means the AI can screenshot the running game, inspect live node properties, draw debug overlays, watch property changes over time, and read performance metrics — all without modifying your game code.

### Visualizer System

The visualizer draws on a `CanvasLayer` at z-index 100, above all game content:

- **Shapes**: rectangles, circles, lines, arrows, labels with configurable color and thickness
- **Node highlighting**: automatically adapts to Control (rect), Node2D (circle), or generic nodes (label)
- **Auto-screenshot**: `debug_draw_overlay` and `highlight_node` capture a screenshot after drawing so the AI sees the result
- **Auto-expire**: overlays clear after a configurable duration

## Setup

### Prerequisites

- Godot 4.2+ (tested on 4.6)
- Node.js 20+

### Installation

#### Option A: Symlink (for development)

```sh
# Clone the repo
git clone https://github.com/drunikbe/godot-mcp.git
cd godot-mcp/server && npm install && npm run build

# Symlink the addon into your Godot project
ln -s /path/to/godot-mcp/addons/godot_mcp /path/to/your-project/addons/godot_mcp
```

#### Option B: npx (coming soon)

```sh
npx @drunik/godot-mcp --daemon
```

### Enable the Plugin

1. Open your Godot project
2. Go to **Project > Project Settings > Plugins**
3. Enable **Godot MCP**
4. The plugin auto-starts the daemon if it detects the server in the symlinked repo

### Configure Your AI Client

**Claude Code / clients with streamable-http support:**

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "godot-mcp": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:6506/mcp"
    }
  }
}
```

> **Note:** The port (6506) is the default. If you use `--project`, each project gets a unique port via hash. Check `.godot/mcp-daemon.json` for the actual port.

**Claude Desktop / stdio-only clients:**

```json
{
  "mcpServers": {
    "godot-mcp": {
      "command": "node",
      "args": ["/path/to/godot-mcp/server/dist/index.js", "--project", "/path/to/your-godot-project"]
    }
  }
}
```

The shim auto-starts a background HTTP daemon and proxies stdio messages to it. The `--project` flag tells it which Godot project to connect to.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GODOT_MCP_PORT` | auto | WebSocket port for Godot (overrides hash-based assignment) |
| `GODOT_MCP_HTTP_PORT` | auto | HTTP port for MCP clients (overrides hash-based assignment) |
| `GODOT_MCP_TIMEOUT_MS` | 30000 | Tool call timeout in ms |
| `GODOT_MCP_IDLE_TIMEOUT_MS` | 30000 | Daemon auto-shutdown when idle (no Godot + no sessions) |
| `GODOT_MCP_PROJECT` | — | Godot project path (alternative to `--project` flag) |
| `GODOT_PATH` | `godot` | Path to Godot binary (for `start_godot` tool) |

### CLI Flags

```
node dist/index.js [flags]

--project <path>  Godot project path (enables dynamic ports + process management)
--port <n>        Override the HTTP port
--daemon          Force daemon mode (needed when stdin is piped, e.g., tests)
--no-force        Don't kill existing processes on startup
--http            Accepted for backwards compat (no-op, HTTP is always on)
```

### Port Assignment

Without `--project`, the server uses default ports 6505/6506. With `--project`, each project gets a unique port pair derived from its absolute path via FNV-1a hash (range 6505–8504). This means multiple Godot projects can run simultaneously without port conflicts.

The daemon writes `.godot/mcp-daemon.json` with its actual ports so that shims and plugins can discover it.

## Architecture

### Data Flow

```
                    ┌─────────────────────────────────────────────┐
                    │              Node.js Daemon                  │
 AI (stdio) ──>     │                                              │
   shim ──────────> │  HTTP ──> MCP Server ──> GodotBridge        │
 AI (HTTP) ───────> │  :auto     (server.ts)    (WebSocket)        │
                    │                 │              │              │
                    │         Tool validation    :auto              │
                    │         Resource serving       │              │
                    │         Screenshot encoding    │              │
                    └───────────────────────│────────┘
                                           │
                                           │ WebSocket
                                           │
                    ┌─────────────────────────────────────────────┐
                    │              Godot Editor Process            │
                    │                                              │
                    │  MCPClient ──> CommandHandler ──> Processors │
                    │  (WebSocket     (router)     FileCommands    │
                    │   client)                    SceneCommands   │
                    │      │                       ScriptCommands  │
                    │      │                       ProjectCommands │
                    │      │                       AssetCommands   │
                    │      │                       RuntimeCommands │
                    │      │                       VisualizerCmds  │
                    │      │                                       │
                    │   DebuggerPlugin ─────> Running Game         │
                    │   (EditorDebugger       (__MCPRuntimeBridge) │
                    │    Plugin)               screenshots         │
                    │                          debug overlays      │
                    │                          property watching   │
                    └─────────────────────────────────────────────┘
```

### Command Processing Pattern

The plugin uses **Chain of Responsibility**: the `CommandHandler` iterates registered processors until one handles the tool name. Each processor:

1. Declares its tools via `get_supported_tools() -> PackedStringArray`
2. Routes via `handles_tool(name) -> bool`
3. Executes via `process_command(name, args) -> Dictionary`
4. Returns `{&"ok": true, ...data}` or `{&"ok": false, &"error": "message"}`

### WebSocket Protocol

Messages between server and plugin are JSON over WebSocket:

| Direction | Type | Purpose |
|-----------|------|---------|
| Server -> Plugin | `tool_invoke` | Execute a tool with `{id, tool, args}` |
| Plugin -> Server | `tool_result` | Return result with `{id, success, result/error}` |
| Server -> Plugin | `ping` | Keepalive (every 10s) |
| Plugin -> Server | `pong` | Keepalive response |
| Plugin -> Server | `godot_ready` | Connection established with `{project_path}` |

### Screenshot Pipeline

For tools that produce images (`game_screenshot`, `debug_draw_overlay`, `highlight_node`):

1. GDScript captures the viewport to a PNG file on disk
2. Returns the absolute file path in the tool result
3. Server reads the PNG, encodes as base64
4. Returns as MCP `ImageContent` alongside text metadata
5. AI client renders the image inline

## Testing

### Server Tests (Node.js)

```sh
cd server
npm run build
npm test
```

67 tests covering initialization, tool listing, resource listing, WebSocket round-trip, session management, assert tools, and lifecycle tools.

### Plugin Tests (GDScript)

Run from any Godot project with the addon:

```sh
godot --headless --script res://tests/test_plugin.gd
```

43 tests validating class loading, processor instantiation, tool declarations, command routing, and WebSocket client contracts.

## Adding New Tools

1. Define the tool schema in `server/src/tools/<domain>-tools.ts`
2. Register in `server/src/tools/index.ts`
3. Implement the handler in `addons/godot_mcp/commands/<domain>_commands.gd` extending `MCPBaseCommandProcessor`
4. Register the processor in `commands/command_handler.gd`
5. Rebuild: `cd server && npm run build`

### Tool Conventions

- **Descriptions**: 1-2 sentences, action-oriented. Use CAPS for constraints (e.g., "RUNNING game" vs editor).
- **Validation**: Always validate inputs before executing. Return `{&"ok": false, &"error": "..."}`.
- **Results**: All handlers return Dictionary with `&"ok": bool`.
- **Naming**: snake_case, prefixed by domain (`game_`, `debug_`).

## Contributing

This project uses [GitHub Flow](https://docs.github.com/en/get-started/using-git/github-flow):

1. Create a feature branch from `main`: `git checkout -b feature/my-change`
2. Make changes, commit with clear messages
3. Open a pull request against `main`
4. After review and CI pass, merge to `main`
5. Tag releases with semantic versions: `git tag v0.2.0`

Versioning follows [Semantic Versioning](https://semver.org/). The version lives in three places — keep them in sync:
- `server/package.json` (source of truth, read at runtime)
- `addons/godot_mcp/plugin.cfg`
- `CHANGELOG.md`

## Compatibility

- **Godot**: 4.2+ (runtime debugging requires 4.2+, tested on 4.6)
- **Node.js**: 20+
- **MCP Protocol**: 2025-03-26
- **Platforms**: macOS, Linux, Windows

## License

MIT
