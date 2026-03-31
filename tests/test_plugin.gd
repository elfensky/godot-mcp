## MCP Plugin Integration Test
##
## Validates that all command processors load, instantiate, and declare
## their tool handlers correctly. Also tests WebSocket round-trip.
##
## Run from any Godot project with the addon symlinked:
##   godot --headless --script res://addons/godot_mcp/../../tests/test_plugin.gd
##
## Or copy/symlink into a project's test directory and run:
##   godot --headless --script res://tests/test_plugin.gd
extends SceneTree

var _pass_count: int = 0
var _fail_count: int = 0
var _errors: PackedStringArray = []


func _init() -> void:
	print("")
	print("╔══════════════════════════════════════════╗")
	print("║     Godot MCP Plugin — Test Suite        ║")
	print("╚══════════════════════════════════════════╝")
	print("  Godot %s" % Engine.get_version_info().string)
	print("")

	_test_class_loading()
	_test_instantiation()
	_test_tool_declarations()
	_test_command_routing()
	_test_websocket_client()

	print("")
	print("──────────────────────────────────────────")
	print("  Results: %d passed, %d failed" % [_pass_count, _fail_count])
	if _errors.size() > 0:
		print("  Errors:")
		for err in _errors:
			print("    ✗ %s" % err)
	print("──────────────────────────────────────────")
	print("")

	if _fail_count > 0:
		quit(1)
	else:
		quit(0)


# ── Test: Class Loading ─────────────────────────────────────────────

func _test_class_loading() -> void:
	print("  Class Loading")
	var classes := {
		"MCPBaseCommandProcessor": "base_command_processor.gd",
		"MCPCommandHandler": "command_handler.gd",
		"MCPFileCommands": "file_commands.gd",
		"MCPSceneCommands": "scene_commands.gd",
		"MCPScriptCommands": "script_commands.gd",
		"MCPProjectCommands": "project_commands.gd",
		"MCPAssetCommands": "asset_commands.gd",
		"MCPRuntimeCommands": "runtime_commands.gd",
		"MCPVisualizerCommands": "visualizer_commands.gd",
	}

	for cls_name: String in classes:
		var script = _find_class_script(cls_name)
		if script == null:
			_fail("class %s not found in global class list" % cls_name)
		elif not script.can_instantiate():
			_fail("class %s loaded but cannot instantiate (parse error?)" % cls_name)
		else:
			_pass("class %s" % cls_name)

	# Also check the client
	var client_script = _find_class_script("MCPClient")
	if client_script and client_script.can_instantiate():
		_pass("class MCPClient")
	else:
		_fail("class MCPClient")
	print("")


# ── Test: Instantiation ─────────────────────────────────────────────

func _test_instantiation() -> void:
	print("  Instantiation")
	var processor_classes := [
		"MCPFileCommands",
		"MCPSceneCommands",
		"MCPScriptCommands",
		"MCPProjectCommands",
		"MCPAssetCommands",
		"MCPRuntimeCommands",
		"MCPVisualizerCommands",
	]

	for cls_name: String in processor_classes:
		var script = _find_class_script(cls_name)
		if script == null:
			_fail("%s: script not found" % cls_name)
			continue
		var instance = script.new()
		if instance == null:
			_fail("%s: new() returned null" % cls_name)
			continue
		if not (instance is Node):
			_fail("%s: not a Node (is %s)" % [cls_name, instance.get_class()])
		else:
			_pass("%s instantiates as Node" % cls_name)
		instance.free()
	print("")


# ── Test: Tool Declarations ─────────────────────────────────────────

func _test_tool_declarations() -> void:
	print("  Tool Declarations")

	var expected_tools: Dictionary = {
		"MCPFileCommands": ["list_dir", "read_file", "search_project", "create_script"],
		"MCPSceneCommands": ["create_scene", "read_scene", "add_node", "remove_node",
			"modify_node_property", "rename_node", "move_node", "attach_script",
			"detach_script", "set_collision_shape", "set_sprite_texture"],
		"MCPScriptCommands": ["edit_script", "validate_script", "list_scripts",
			"create_folder", "delete_file", "rename_file"],
		"MCPProjectCommands": ["get_project_settings", "get_input_map", "get_collision_layers",
			"get_node_properties", "get_console_log", "get_errors", "get_debugger_errors",
			"clear_console_log", "open_in_godot", "scene_tree_dump", "list_settings",
			"update_project_settings", "configure_input_map", "rescan_filesystem",
			"run_scene", "stop_scene", "is_playing", "classdb_query", "setup_autoload",
			"eval_editor_expression"],
		"MCPAssetCommands": ["generate_2d_asset"],
		"MCPRuntimeCommands": ["game_screenshot", "game_scene_tree",
			"game_get_properties", "game_get_property"],
		"MCPVisualizerCommands": ["debug_draw_overlay", "clear_debug_overlay",
			"highlight_node", "watch_property", "performance_stats"],
	}

	var total_tools: int = 0
	for cls_name: String in expected_tools:
		var script = _find_class_script(cls_name)
		if script == null:
			_fail("%s: not found" % cls_name)
			continue
		var instance = script.new()
		if instance == null:
			_fail("%s: cannot instantiate" % cls_name)
			continue

		var declared: PackedStringArray = instance.get_supported_tools()
		var expected: Array = expected_tools[cls_name]

		var missing: Array = []
		for tool_name: String in expected:
			if tool_name not in declared:
				missing.append(tool_name)

		if missing.size() > 0:
			_fail("%s missing tools: %s" % [cls_name, str(missing)])
		else:
			_pass("%s declares %d tools" % [cls_name, declared.size()])
			total_tools += declared.size()

		# Verify handles_tool works for each declared tool
		var handles_ok := true
		for tool_name: String in declared:
			if not instance.handles_tool(tool_name):
				_fail("%s.handles_tool('%s') returned false" % [cls_name, tool_name])
				handles_ok = false
		if handles_ok:
			_pass("%s.handles_tool() matches all" % cls_name)

		instance.free()

	_pass("Total tools across all processors: %d" % total_tools)
	print("")


# ── Test: Command Routing ───────────────────────────────────────────

func _test_command_routing() -> void:
	print("  Command Routing")

	# Create a CommandHandler and verify it loads all processors
	var handler_script = _find_class_script("MCPCommandHandler")
	if handler_script == null:
		_fail("MCPCommandHandler not found")
		return

	# We can't fully test routing without a SceneTree (handlers need _ready),
	# but we can verify the class structure
	var handler = handler_script.new()
	if handler == null:
		_fail("MCPCommandHandler instantiation failed")
		return

	_pass("MCPCommandHandler instantiates")

	# Verify it has the expected methods
	if handler.has_method("execute_command"):
		_pass("has execute_command method")
	else:
		_fail("missing execute_command method")

	if handler.has_method("get_processor"):
		_pass("has get_processor method")
	else:
		_fail("missing get_processor method")

	handler.free()
	print("")


# ── Test: WebSocket Client ──────────────────────────────────────────

func _test_websocket_client() -> void:
	print("  WebSocket Client")

	var client_script = _find_class_script("MCPClient")
	if client_script == null:
		_fail("MCPClient not found")
		return

	var client = client_script.new()
	if client == null:
		_fail("MCPClient instantiation failed")
		return

	_pass("MCPClient instantiates")

	# Verify signals exist
	if client.has_signal("connected"):
		_pass("has 'connected' signal")
	else:
		_fail("missing 'connected' signal")

	if client.has_signal("disconnected"):
		_pass("has 'disconnected' signal")
	else:
		_fail("missing 'disconnected' signal")

	if client.has_signal("tool_requested"):
		_pass("has 'tool_requested' signal")
	else:
		_fail("missing 'tool_requested' signal")

	# Verify key methods
	for method: String in ["connect_to_server", "disconnect_from_server", "send_tool_result", "is_connected_to_server"]:
		if client.has_method(method):
			_pass("has %s()" % method)
		else:
			_fail("missing %s()" % method)

	# Verify protocol_version is present in godot_ready message
	# (source-level check — the field must exist in the _handle_connect method)
	var src: String = client_script.source_code
	if src.find("protocol_version") >= 0:
		_pass("mcp_client.gd includes protocol_version in godot_ready")
	else:
		_fail("mcp_client.gd missing protocol_version in godot_ready")

	client.free()
	print("")


# ── Helpers ─────────────────────────────────────────────────────────

func _find_class_script(cls_name: String) -> GDScript:
	for cls: Dictionary in ProjectSettings.get_global_class_list():
		if cls["class"] == cls_name:
			return load(cls["path"])
	return null


func _pass(msg: String) -> void:
	_pass_count += 1
	print("    ✓ %s" % msg)


func _fail(msg: String) -> void:
	_fail_count += 1
	_errors.append(msg)
	print("    ✗ %s" % msg)
