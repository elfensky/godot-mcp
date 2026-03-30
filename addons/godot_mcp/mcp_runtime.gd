extends Node
## Game-side companion for MCP runtime debugging.
##
## Injected as autoload "__MCPRuntimeBridge__" before play.
## Communicates with editor via EngineDebugger message channel.
## NOT a @tool script — runs only in the game process.

const MAX_QUEUE_DEPTH := 20
const MAX_PER_FRAME := 2

var _command_queue: Array[Array] = []


func _ready() -> void:
	if not OS.has_feature("debug"):
		queue_free()
		return
	if not EngineDebugger.is_active():
		queue_free()
		return

	process_mode = Node.PROCESS_MODE_ALWAYS
	EngineDebugger.register_message_capture("mcp", _on_mcp_message)


func _on_mcp_message(message: String, data: Array) -> bool:
	if message != "command" or data.size() < 3:
		return false

	var request_id: int = data[0]
	var command: String = data[1]
	var args: Dictionary = data[2] if data[2] is Dictionary else {}

	if _command_queue.size() >= MAX_QUEUE_DEPTH:
		var discarded := _command_queue.pop_front()
		_send_response(discarded[0], {&"ok": false, &"error": "Request queue overflow — discarded"})

	_command_queue.push_back([request_id, command, args])
	return true


func _process(_delta: float) -> void:
	var processed := 0
	while _command_queue.size() > 0 and processed < MAX_PER_FRAME:
		var entry: Array = _command_queue.pop_front()
		_execute_command(entry[0], entry[1], entry[2])
		processed += 1


func _execute_command(request_id: int, command: String, args: Dictionary) -> void:
	match command:
		"screenshot":
			_handle_screenshot.call_deferred(request_id, args)
		"tree_dump":
			_handle_tree_dump(request_id, args)
		"get_properties":
			_handle_get_properties(request_id, args)
		"get_property":
			_handle_get_property(request_id, args)
		_:
			_send_response(request_id, {&"ok": false, &"error": "Unknown command: %s" % command})


func _handle_screenshot(request_id: int, args: Dictionary) -> void:
	var screenshot_dir: String = args.get("screenshot_path", ".godot/mcp-screenshots/")
	var abs_dir := ProjectSettings.globalize_path("res://" + screenshot_dir)

	if not DirAccess.dir_exists_absolute(abs_dir):
		DirAccess.make_dir_recursive_absolute(abs_dir)

	await RenderingServer.frame_post_draw

	var vp := get_viewport()
	if args.has("node_path") and args.node_path != "":
		var sub_vp := get_node_or_null(NodePath(args.node_path))
		if sub_vp is SubViewport:
			vp = sub_vp
		else:
			_send_response(request_id, {&"ok": false, &"error": "SubViewport not found: %s" % args.node_path})
			return

	var image := vp.get_texture().get_image()
	if image == null:
		_send_response(request_id, {&"ok": false, &"error": "Screenshot capture failed — viewport texture unavailable"})
		return

	var timestamp := Time.get_datetime_string_from_system().replace(":", "").replace("-", "").replace("T", "_")
	var filename := "screenshot_%s.png" % timestamp
	var abs_path := abs_dir.path_join(filename)

	var err := image.save_png(abs_path)
	if err != OK:
		_send_response(request_id, {&"ok": false, &"error": "Failed to save screenshot: error %d" % err})
		return

	_cleanup_screenshots(abs_dir, 10)

	_send_response(request_id, {
		&"ok": true,
		&"path": abs_path,
		&"width": image.get_width(),
		&"height": image.get_height(),
	})


func _cleanup_screenshots(dir_path: String, keep: int) -> void:
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return
	var files: PackedStringArray = []
	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		if not dir.current_is_dir() and file_name.begins_with("screenshot_") and file_name.ends_with(".png"):
			files.append(file_name)
		file_name = dir.get_next()
	dir.list_dir_end()

	if files.size() <= keep:
		return

	files.sort()
	var to_delete := files.size() - keep
	for i in range(to_delete):
		DirAccess.remove_absolute(dir_path.path_join(files[i]))


const SENSITIVE_PATTERN := "(?i)(key|token|secret|password|credential|auth)"
var _sensitive_regex: RegEx


func _get_sensitive_regex() -> RegEx:
	if _sensitive_regex == null:
		_sensitive_regex = RegEx.new()
		_sensitive_regex.compile(SENSITIVE_PATTERN)
	return _sensitive_regex


func _handle_tree_dump(request_id: int, args: Dictionary) -> void:
	var max_depth: int = args.get("max_depth", 3)
	var max_nodes: int = args.get("max_nodes", 200)
	var root := get_tree().root
	var result_tree := _serialize_node(root, 0, max_depth, max_nodes, {&"count": 0, &"truncated": false})
	_send_response(request_id, {
		&"ok": true,
		&"tree": result_tree.data,
		&"total_nodes": result_tree.count,
		&"truncated": result_tree.truncated,
	})


func _serialize_node(node: Node, depth: int, max_depth: int, max_nodes: int, state: Dictionary) -> Dictionary:
	state.count += 1
	if state.count > max_nodes:
		state.truncated = true
		return {&"data": null, &"count": state.count, &"truncated": true}

	var data := {
		&"name": node.name,
		&"class": node.get_class(),
		&"path": str(node.get_path()),
	}
	var groups := node.get_groups()
	if groups.size() > 0:
		data[&"groups"] = groups
	var script = node.get_script()
	if script and script is Script:
		data[&"script"] = script.resource_path
	data[&"child_count"] = node.get_child_count()
	if depth < max_depth and node.get_child_count() > 0:
		var children := []
		for child in node.get_children():
			if state.count > max_nodes:
				state.truncated = true
				break
			var child_result := _serialize_node(child, depth + 1, max_depth, max_nodes, state)
			if child_result.data != null:
				children.append(child_result.data)
		if children.size() > 0:
			data[&"children"] = children
	return {&"data": data, &"count": state.count, &"truncated": state.truncated}


func _handle_get_properties(request_id: int, args: Dictionary) -> void:
	var node_path: String = args.get("node_path", "")
	if node_path == "":
		_send_response(request_id, {&"ok": false, &"error": "node_path is required"})
		return
	var node := get_node_or_null(NodePath(node_path))
	if node == null:
		_send_response(request_id, {&"ok": false, &"error": "Node not found: %s" % node_path})
		return
	var properties := {}
	var regex := _get_sensitive_regex()
	for prop_info in node.get_property_list():
		if prop_info.usage & PROPERTY_USAGE_EDITOR == 0:
			continue
		var prop_name: String = prop_info.name
		if regex.search(prop_name):
			properties[prop_name] = "[REDACTED]"
		else:
			properties[prop_name] = _serialize_value(node.get(prop_name))
	_send_response(request_id, {
		&"ok": true,
		&"node_path": node_path,
		&"node_class": node.get_class(),
		&"properties": properties,
	})


func _handle_get_property(request_id: int, args: Dictionary) -> void:
	var node_path: String = args.get("node_path", "")
	var property: String = args.get("property", "")
	if node_path == "" or property == "":
		_send_response(request_id, {&"ok": false, &"error": "node_path and property are required"})
		return
	var node := get_node_or_null(NodePath(node_path))
	if node == null:
		_send_response(request_id, {&"ok": false, &"error": "Node not found: %s" % node_path})
		return
	if not property in node:
		_send_response(request_id, {&"ok": false, &"error": "Property '%s' not found on node '%s'" % [property, node_path]})
		return
	var regex := _get_sensitive_regex()
	var value
	if regex.search(property):
		value = "[REDACTED]"
	else:
		value = _serialize_value(node.get(property))
	_send_response(request_id, {
		&"ok": true,
		&"node_path": node_path,
		&"property": property,
		&"value": value,
	})


func _serialize_value(value) -> Variant:
	if value == null:
		return null
	if value is bool or value is int or value is float or value is String:
		return value
	if value is Vector2 or value is Vector3 or value is Vector2i or value is Vector3i:
		return value
	if value is Color or value is Rect2 or value is Rect2i:
		return value
	if value is Transform2D or value is Transform3D or value is Basis:
		return value
	if value is Array or value is PackedStringArray or value is PackedInt32Array or value is PackedFloat32Array:
		return value
	if value is Dictionary:
		return value
	if value is Node:
		return {&"_type": "Node", &"class": value.get_class(), &"path": str(value.get_path())}
	if value is Resource:
		return {&"_type": "Resource", &"class": value.get_class(), &"path": value.resource_path}
	if value is Callable or value is Signal or value is RID:
		return {&"_type": type_string(typeof(value)), &"string": str(value)}
	return str(value)


func _send_response(request_id: int, result: Dictionary) -> void:
	EngineDebugger.send_message("mcp:response", [request_id, result])
