@tool
class_name MCPRuntimeCommands
extends MCPBaseCommandProcessor
## Runtime debugging commands: game_screenshot, game_scene_tree,
## game_get_properties, game_get_property
##
## All handlers are async — they send commands to the running game
## via EditorDebuggerPlugin and poll for responses.

var _debugger_plugin = null
var _screenshot_path: String = ".godot/mcp-screenshots/"
var _debugger_timeout_sec: float = 20.0


func set_debugger_plugin(plugin) -> void:
	_debugger_plugin = plugin


func set_screenshot_path(path: String) -> void:
	_screenshot_path = path


func get_supported_tools() -> PackedStringArray:
	return PackedStringArray([
		"game_screenshot", "game_scene_tree",
		"game_get_properties", "game_get_property"
	])


func process_command(tool_name: String, args: Dictionary) -> Dictionary:
	match tool_name:
		"game_screenshot":
			return await handle_game_screenshot(args)
		"game_scene_tree":
			return await handle_game_scene_tree(args)
		"game_get_properties":
			return await handle_game_get_properties(args)
		"game_get_property":
			return await handle_game_get_property(args)
	return {&"ok": false, &"error": "Unknown runtime command: " + tool_name}


func handle_game_screenshot(args: Dictionary) -> Dictionary:
	if _debugger_plugin == null or not _debugger_plugin.has_active_session():
		return {&"ok": false, &"error": "No active debug session — is the game running? Use run_scene to launch."}

	var cmd_args := {}
	cmd_args[&"screenshot_path"] = _screenshot_path
	if args.has("node_path"):
		cmd_args[&"node_path"] = args.node_path

	return await _debugger_plugin.send_command("screenshot", cmd_args, _debugger_timeout_sec)


func handle_game_scene_tree(args: Dictionary) -> Dictionary:
	if _debugger_plugin == null or not _debugger_plugin.has_active_session():
		return {&"ok": false, &"error": "No active debug session — is the game running? Use run_scene to launch."}
	var cmd_args := {}
	if args.has("max_depth"):
		cmd_args[&"max_depth"] = args.max_depth
	if args.has("max_nodes"):
		cmd_args[&"max_nodes"] = args.max_nodes
	return await _debugger_plugin.send_command("tree_dump", cmd_args, _debugger_timeout_sec)


func handle_game_get_properties(args: Dictionary) -> Dictionary:
	if _debugger_plugin == null or not _debugger_plugin.has_active_session():
		return {&"ok": false, &"error": "No active debug session — is the game running? Use run_scene to launch."}
	if not args.has("node_path"):
		return {&"ok": false, &"error": "node_path is required"}
	var cmd_args := {&"node_path": args.node_path}
	return await _debugger_plugin.send_command("get_properties", cmd_args, _debugger_timeout_sec)


func handle_game_get_property(args: Dictionary) -> Dictionary:
	if _debugger_plugin == null or not _debugger_plugin.has_active_session():
		return {&"ok": false, &"error": "No active debug session — is the game running? Use run_scene to launch."}
	if not args.has("node_path"):
		return {&"ok": false, &"error": "node_path is required"}
	if not args.has("property"):
		return {&"ok": false, &"error": "property is required"}
	var cmd_args := {&"node_path": args.node_path, &"property": args.property}
	return await _debugger_plugin.send_command("get_property", cmd_args, _debugger_timeout_sec)
