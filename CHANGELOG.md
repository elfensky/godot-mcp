# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-03-31

### Added
- MCP server with stdio and HTTP daemon transport modes
- WebSocket bridge connecting MCP server to Godot editor plugin
- 51 tools across 8 categories:
  - **File** (4): `list_dir`, `read_file`, `search_project`, `create_script`
  - **Scene** (11): `create_scene`, `read_scene`, `add_node`, `remove_node`, `modify_node_property`, `rename_node`, `move_node`, `attach_script`, `detach_script`, `set_collision_shape`, `set_sprite_texture`
  - **Script** (6): `edit_script`, `validate_script`, `list_scripts`, `create_folder`, `delete_file`, `rename_file`
  - **Project** (19): `get_project_settings`, `get_input_map`, `get_collision_layers`, `get_node_properties`, `get_console_log`, `get_errors`, `get_debugger_errors`, `clear_console_log`, `open_in_godot`, `scene_tree_dump`, `list_settings`, `update_project_settings`, `configure_input_map`, `rescan_filesystem`, `run_scene`, `stop_scene`, `is_playing`, `classdb_query`, `setup_autoload`
  - **Asset** (1): `generate_2d_asset`
  - **Runtime** (4): `game_screenshot`, `game_scene_tree`, `game_get_properties`, `game_get_property`
  - **Visualizer** (5): `debug_draw_overlay`, `clear_debug_overlay`, `highlight_node`, `watch_property`, `performance_stats`
  - **Status** (1): `get_godot_status` (built-in)
- 9 read-only MCP resources: `godot://project/settings`, `godot://project/input-map`, `godot://scenes`, `godot://scripts`, `godot://editor/scene-tree`, `godot://editor/errors`, `godot://editor/console`, `godot://scene/{path}`, `godot://file/{path}`
- Godot 4.x editor plugin with auto-reconnecting WebSocket client
- Auto-daemon startup from symlinked addon repos
- Runtime debugging via `EditorDebuggerPlugin` with auto-injected `__MCPRuntimeBridge__` autoload
- Visualizer overlay system using `CanvasLayer` at z-index 100
- Screenshot post-processing pipeline (PNG to base64 `ImageContent`)
- Idle auto-shutdown for HTTP daemon mode
- Server test suite (16 tests, Node.js `node:test`)
- Plugin test suite (43 tests, Godot headless)

### Fixed
- Godot 4.6 strict type inference errors causing 5 of 7 command processors to fail loading
- Shutdown race condition where `transport.close()` callback deleted session before `server.close()`
- Scene resource template using wrong parameter name (`path` -> `scene_path`)

[Unreleased]: https://github.com/drunikbe/godot-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/drunikbe/godot-mcp/releases/tag/v0.1.0
