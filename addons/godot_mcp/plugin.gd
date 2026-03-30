@tool
extends EditorPlugin
## Godot MCP Plugin
##
## Connects to the godot-mcp server via WebSocket and executes tools.
## The plugin acts as a WebSocket client connecting to the MCP server's
## WebSocket server on port 6505 (configurable).

const MCPClientScript = preload("res://addons/godot_mcp/mcp_client.gd")
const CommandHandlerScript = preload("res://addons/godot_mcp/commands/command_handler.gd")
const MCPDebuggerPluginScript = preload("res://addons/godot_mcp/mcp_debugger_plugin.gd")

var _mcp_client: Node
var _command_handler: Node
var _status_label: Label
var _debugger_plugin = null
var _autoload_injected: bool = false
var _runtime_debugging_enabled: bool = false
var _screenshot_path: String = ".godot/mcp-screenshots/"


func _enter_tree() -> void:
	print("[Godot MCP] Plugin loading...")

	# Clean up stale autoload from previous crash
	_cleanup_stale_autoload()

	# Store plugin instance for command processors to access EditorInterface
	Engine.set_meta("GodotMCPPlugin", self)

	# Register debugger plugin (Godot 4.2+)
	if _check_runtime_debug_support():
		_debugger_plugin = MCPDebuggerPluginScript.new()
		add_debugger_plugin(_debugger_plugin)

	# Create MCP client (WebSocket connection to server)
	_mcp_client = MCPClientScript.new()
	_mcp_client.name = "MCPClient"
	add_child(_mcp_client)

	# Create command handler (routes tool calls to processors)
	_command_handler = CommandHandlerScript.new()
	_command_handler.name = "CommandHandler"
	add_child(_command_handler)

	# Pass debugger plugin to runtime commands after handler initializes
	await get_tree().process_frame
	_setup_runtime_commands()

	# Connect signals
	_mcp_client.connected.connect(_on_connected)
	_mcp_client.disconnected.connect(_on_disconnected)
	_mcp_client.tool_requested.connect(_on_tool_requested)

	# Add status indicator to editor toolbar
	_setup_status_indicator()

	# Start connection
	_mcp_client.connect_to_server()

	print("[Godot MCP] Plugin loaded — connecting to MCP server...")


func _setup_runtime_commands() -> void:
	if _debugger_plugin and _command_handler:
		var runtime_cmd = _command_handler.get_processor("RuntimeCommands")
		if runtime_cmd:
			runtime_cmd.set_debugger_plugin(_debugger_plugin)
			runtime_cmd.set_screenshot_path(_screenshot_path)


func _check_runtime_debug_support() -> bool:
	var version := Engine.get_version_info()
	if version.major < 4 or (version.major == 4 and version.minor < 2):
		push_warning("[Godot MCP] Runtime debugging requires Godot 4.2+")
		return false
	return true


func _cleanup_stale_autoload() -> void:
	if ProjectSettings.has_setting("autoload/__MCPRuntimeBridge__"):
		push_warning("[Godot MCP] Removing stale __MCPRuntimeBridge__ autoload from previous session")
		remove_autoload_singleton("__MCPRuntimeBridge__")
		ProjectSettings.save()


func _inject_runtime_autoload() -> bool:
	if ProjectSettings.has_setting("autoload/__MCPRuntimeBridge__"):
		var existing = ProjectSettings.get_setting("autoload/__MCPRuntimeBridge__")
		if existing != "*res://addons/godot_mcp/mcp_runtime.gd":
			push_warning("[Godot MCP] Autoload __MCPRuntimeBridge__ already exists with different script")
			return false
		return true

	add_autoload_singleton("__MCPRuntimeBridge__", "res://addons/godot_mcp/mcp_runtime.gd")
	ProjectSettings.save()
	_autoload_injected = true
	return true


func _remove_runtime_autoload() -> void:
	if _autoload_injected:
		remove_autoload_singleton("__MCPRuntimeBridge__")
		ProjectSettings.save()
		_autoload_injected = false
		var abs_dir := ProjectSettings.globalize_path("res://" + _screenshot_path)
		_cleanup_screenshot_dir(abs_dir)


func _cleanup_screenshot_dir(dir_path: String) -> void:
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return
	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		if not dir.current_is_dir() and file_name.begins_with("screenshot_") and file_name.ends_with(".png"):
			DirAccess.remove_absolute(dir_path.path_join(file_name))
		file_name = dir.get_next()
	dir.list_dir_end()


func _exit_tree() -> void:
	print("[Godot MCP] Plugin unloading...")

	if Engine.has_meta("GodotMCPPlugin"):
		Engine.remove_meta("GodotMCPPlugin")

	if _mcp_client:
		_mcp_client.disconnect_from_server()
		_mcp_client.queue_free()

	if _command_handler:
		_command_handler.queue_free()

	if _status_label:
		remove_control_from_container(EditorPlugin.CONTAINER_TOOLBAR, _status_label)
		_status_label.queue_free()

	_remove_runtime_autoload()
	if _debugger_plugin:
		remove_debugger_plugin(_debugger_plugin)
		_debugger_plugin = null

	print("[Godot MCP] Plugin unloaded")


func _setup_status_indicator() -> void:
	_status_label = Label.new()
	_status_label.text = "MCP: Connecting..."
	_status_label.add_theme_color_override("font_color", Color.YELLOW)
	_status_label.add_theme_font_size_override("font_size", 12)
	add_control_to_container(EditorPlugin.CONTAINER_TOOLBAR, _status_label)


func _on_connected() -> void:
	print("[Godot MCP] Connected to MCP server")
	if _status_label:
		_status_label.text = "MCP: Connected"
		_status_label.add_theme_color_override("font_color", Color.GREEN)


func _on_disconnected() -> void:
	print("[Godot MCP] Disconnected from MCP server")
	if _status_label:
		_status_label.text = "MCP: Disconnected"
		_status_label.add_theme_color_override("font_color", Color.RED)
	if _debugger_plugin:
		_debugger_plugin.cancel_all_pending()


func _on_tool_requested(request_id: String, tool_name: String, args: Dictionary) -> void:
	print("[Godot MCP] Executing tool: ", tool_name)

	# Auto-enable runtime debugging on first game_* call
	if tool_name.begins_with("game_") and not _runtime_debugging_enabled:
		_runtime_debugging_enabled = true
		print("[Godot MCP] Runtime debugging auto-enabled")

	# Inject autoload before run_scene if runtime debugging is enabled
	if tool_name == "run_scene" and _runtime_debugging_enabled:
		_inject_runtime_autoload()

	# Remove autoload after stop_scene
	if tool_name == "stop_scene" and _autoload_injected:
		var result: Dictionary = await _command_handler.execute_command(tool_name, args)
		_remove_runtime_autoload()
		_send_result(request_id, result)
		return

	# Auto-restart for game_* tools if autoload not injected but scene is running
	if tool_name.begins_with("game_") and not _autoload_injected:
		if EditorInterface.is_playing_scene():
			EditorInterface.stop_playing_scene()
			_inject_runtime_autoload()
			var playing := EditorInterface.get_playing_scene()
			if playing != "":
				EditorInterface.play_custom_scene(playing)
			else:
				EditorInterface.play_main_scene()
			# Wait for debugger session
			var waited := 0.0
			while _debugger_plugin and not _debugger_plugin.has_active_session() and waited < 10.0:
				var tree := Engine.get_main_loop() as SceneTree
				await tree.process_frame
				waited += tree.root.get_process_delta_time()
			if _debugger_plugin and not _debugger_plugin.has_active_session():
				_mcp_client.send_tool_result(request_id, false, null, "Failed to establish debug session after auto-restart")
				return
		else:
			_mcp_client.send_tool_result(request_id, false, null, "Runtime debugging enabled. Use run_scene to launch a scene with live inspection.")
			return

	var result: Dictionary = await _command_handler.execute_command(tool_name, args)
	_send_result(request_id, result)


func _send_result(request_id: String, result: Dictionary) -> void:
	var success: bool = result.get(&"ok", false)
	if success:
		result.erase(&"ok")
		_mcp_client.send_tool_result(request_id, true, result)
	else:
		var error: String = result.get(&"error", "Unknown error")
		_mcp_client.send_tool_result(request_id, false, null, error)
