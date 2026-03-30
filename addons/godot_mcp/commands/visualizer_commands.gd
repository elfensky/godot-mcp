@tool
class_name MCPVisualizerCommands
extends MCPBaseCommandProcessor
## Visualizer commands: debug_draw_overlay, clear_debug_overlay,
## highlight_node, watch_property, performance_stats
##
## All handlers are async — they send commands to the running game
## via EditorDebuggerPlugin and poll for responses.

var _debugger_plugin = null
var _debugger_timeout_sec: float = 20.0


func set_debugger_plugin(plugin) -> void:
	_debugger_plugin = plugin


func get_supported_tools() -> PackedStringArray:
	return PackedStringArray([
		"debug_draw_overlay", "clear_debug_overlay",
		"highlight_node", "watch_property", "performance_stats"
	])


func process_command(tool_name: String, args: Dictionary) -> Dictionary:
	match tool_name:
		"debug_draw_overlay":
			return await _handle_debug_draw(args)
		"clear_debug_overlay":
			return await _handle_clear_overlay(args)
		"highlight_node":
			return await _handle_highlight_node(args)
		"watch_property":
			return await _handle_watch_property(args)
		"performance_stats":
			return await _handle_performance_stats(args)
	return {&"ok": false, &"error": "Unknown visualizer command: " + tool_name}


func _require_debugger() -> Dictionary:
	if _debugger_plugin == null or not _debugger_plugin.has_active_session():
		return {&"ok": false, &"error": "No active debug session — is the game running? Use run_scene to launch."}
	return {}


func _handle_debug_draw(args: Dictionary) -> Dictionary:
	var check := _require_debugger()
	if check.has(&"error"):
		return check

	var cmd_args := {}
	cmd_args[&"shapes"] = args.get("shapes", [])
	cmd_args[&"duration"] = args.get("duration", 3.0)
	cmd_args[&"clear_existing"] = args.get("clear_existing", true)
	return await _debugger_plugin.send_command("debug_draw", cmd_args, _debugger_timeout_sec)


func _handle_clear_overlay(_args: Dictionary) -> Dictionary:
	var check := _require_debugger()
	if check.has(&"error"):
		return check
	return await _debugger_plugin.send_command("clear_overlay", {}, _debugger_timeout_sec)


func _handle_highlight_node(args: Dictionary) -> Dictionary:
	var check := _require_debugger()
	if check.has(&"error"):
		return check

	if not args.has("node_path"):
		return {&"ok": false, &"error": "node_path is required"}

	var cmd_args := {
		&"node_path": args.node_path,
		&"color": args.get("color", "#FF0000"),
		&"duration": args.get("duration", 3.0),
	}
	return await _debugger_plugin.send_command("highlight_node", cmd_args, _debugger_timeout_sec)


func _handle_watch_property(args: Dictionary) -> Dictionary:
	var check := _require_debugger()
	if check.has(&"error"):
		return check

	if not args.has("node_path"):
		return {&"ok": false, &"error": "node_path is required"}
	if not args.has("property"):
		return {&"ok": false, &"error": "property is required"}

	var cmd_args := {
		&"node_path": args.node_path,
		&"property": args.property,
		&"duration": args.get("duration", 2.0),
		&"interval": args.get("interval", 0.1),
	}

	# Use a longer timeout since we're sampling over time
	var sample_timeout := float(cmd_args[&"duration"]) + 5.0
	return await _debugger_plugin.send_command("watch_property", cmd_args, sample_timeout)


func _handle_performance_stats(args: Dictionary) -> Dictionary:
	var check := _require_debugger()
	if check.has(&"error"):
		return check

	var cmd_args := {}
	if args.has("categories"):
		cmd_args[&"categories"] = args.categories
	return await _debugger_plugin.send_command("performance_stats", cmd_args, _debugger_timeout_sec)
