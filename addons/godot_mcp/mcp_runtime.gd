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
		"debug_draw":
			_handle_debug_draw(request_id, args)
		"clear_overlay":
			_handle_clear_overlay(request_id, args)
		"highlight_node":
			_handle_highlight_node(request_id, args)
		"watch_property":
			_handle_watch_property(request_id, args)
		"performance_stats":
			_handle_performance_stats(request_id, args)
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


# ── Visualizer: Debug Draw ──────────────────────────────────────────

var _overlay_canvas: CanvasLayer = null
var _overlay_control: Control = null
var _draw_commands: Array[Dictionary] = []
var _clear_timers: Array[SceneTreeTimer] = []


func _get_overlay() -> Control:
	if _overlay_canvas == null:
		_overlay_canvas = CanvasLayer.new()
		_overlay_canvas.layer = 100
		_overlay_canvas.name = "__MCPOverlay__"
		get_tree().root.add_child.call_deferred(_overlay_canvas)
		await get_tree().process_frame

	if _overlay_control == null:
		_overlay_control = Control.new()
		_overlay_control.name = "DrawSurface"
		_overlay_control.set_anchors_preset(Control.PRESET_FULL_RECT)
		_overlay_control.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_overlay_control.draw.connect(_on_overlay_draw)
		_overlay_canvas.add_child(_overlay_control)

	return _overlay_control


func _on_overlay_draw() -> void:
	if _overlay_control == null:
		return
	for cmd: Dictionary in _draw_commands:
		var color := Color.from_string(str(cmd.get(&"color", "#FF0000")), Color.RED)
		var thickness: float = cmd.get(&"thickness", 2.0)
		match cmd.get(&"type", ""):
			"rect":
				var pos := _to_vec2(cmd.get(&"position", [0, 0]))
				var sz := _to_vec2(cmd.get(&"size", [50, 50]))
				_overlay_control.draw_rect(Rect2(pos, sz), color, false, thickness)
			"circle":
				var pos := _to_vec2(cmd.get(&"position", [0, 0]))
				var radius: float = cmd.get(&"radius", 25.0)
				_overlay_control.draw_arc(pos, radius, 0, TAU, 64, color, thickness)
			"line":
				var pos := _to_vec2(cmd.get(&"position", [0, 0]))
				var end := _to_vec2(cmd.get(&"end", [100, 100]))
				_overlay_control.draw_line(pos, end, color, thickness)
			"arrow":
				var pos := _to_vec2(cmd.get(&"position", [0, 0]))
				var end := _to_vec2(cmd.get(&"end", [100, 100]))
				_overlay_control.draw_line(pos, end, color, thickness)
				var dir := (end - pos).normalized()
				var perp := Vector2(-dir.y, dir.x)
				var arrow_size := 10.0
				_overlay_control.draw_line(end, end - dir * arrow_size + perp * arrow_size * 0.5, color, thickness)
				_overlay_control.draw_line(end, end - dir * arrow_size - perp * arrow_size * 0.5, color, thickness)
			"label":
				var pos := _to_vec2(cmd.get(&"position", [0, 0]))
				var text: String = str(cmd.get(&"text", ""))
				_overlay_control.draw_string(ThemeDB.fallback_font, pos, text, HORIZONTAL_ALIGNMENT_LEFT, -1, 16, color)


func _to_vec2(value) -> Vector2:
	if value is Array and value.size() >= 2:
		return Vector2(float(value[0]), float(value[1]))
	if value is Vector2:
		return value
	return Vector2.ZERO


func _handle_debug_draw(request_id: int, args: Dictionary) -> void:
	var shapes: Array = args.get("shapes", [])
	var duration: float = args.get("duration", 3.0)
	var clear_existing: bool = args.get("clear_existing", true)

	if clear_existing:
		_draw_commands.clear()

	for shape in shapes:
		if shape is Dictionary:
			_draw_commands.append(shape)

	var ctrl := await _get_overlay()
	ctrl.queue_redraw()

	if duration > 0:
		var timer := get_tree().create_timer(duration)
		timer.timeout.connect(func():
			_draw_commands.clear()
			if _overlay_control:
				_overlay_control.queue_redraw()
		)

	# Take a screenshot after a brief delay so the overlay is visible
	await get_tree().create_timer(0.15).timeout
	await RenderingServer.frame_post_draw

	var screenshot_result := await _capture_screenshot_for_response()
	screenshot_result[&"shapes_drawn"] = shapes.size()
	screenshot_result[&"duration"] = duration
	_send_response(request_id, screenshot_result)


func _handle_clear_overlay(request_id: int, _args: Dictionary) -> void:
	_draw_commands.clear()
	if _overlay_control:
		_overlay_control.queue_redraw()
	_send_response(request_id, {&"ok": true, &"message": "Debug overlays cleared"})


# ── Visualizer: Highlight Node ──────────────────────────────────────

func _handle_highlight_node(request_id: int, args: Dictionary) -> void:
	var node_path: String = args.get("node_path", "")
	var color_str: String = args.get("color", "#FF0000")
	var duration: float = args.get("duration", 3.0)

	if node_path.is_empty():
		_send_response(request_id, {&"ok": false, &"error": "node_path is required"})
		return

	var node := get_node_or_null(NodePath(node_path))
	if node == null:
		_send_response(request_id, {&"ok": false, &"error": "Node not found: %s" % node_path})
		return

	# Build a highlight rect around the node
	var draw_shape := {}
	if node is Control:
		var rect := (node as Control).get_global_rect()
		draw_shape = {
			&"type": "rect",
			&"position": [rect.position.x, rect.position.y],
			&"size": [rect.size.x, rect.size.y],
			&"color": color_str,
			&"thickness": 3.0,
		}
	elif node is Node2D:
		var n2d := node as Node2D
		var pos := n2d.global_position
		# Try to get a meaningful size from sprite or collision
		var radius := 30.0
		if n2d.has_method("get_rect"):
			var r: Rect2 = n2d.call("get_rect")
			radius = maxf(r.size.x, r.size.y) * 0.6
		draw_shape = {
			&"type": "circle",
			&"position": [pos.x, pos.y],
			&"radius": radius,
			&"color": color_str,
			&"thickness": 3.0,
		}
	else:
		# Generic node — just draw a label at screen center
		var vp_size := get_viewport().get_visible_rect().size
		draw_shape = {
			&"type": "label",
			&"position": [vp_size.x * 0.5, 30],
			&"text": ">> %s <<" % node_path,
			&"color": color_str,
		}

	_draw_commands.clear()
	_draw_commands.append(draw_shape)

	var ctrl := await _get_overlay()
	ctrl.queue_redraw()

	if duration > 0:
		var timer := get_tree().create_timer(duration)
		timer.timeout.connect(func():
			_draw_commands.clear()
			if _overlay_control:
				_overlay_control.queue_redraw()
		)

	await get_tree().create_timer(0.15).timeout
	await RenderingServer.frame_post_draw

	var screenshot_result := await _capture_screenshot_for_response()
	screenshot_result[&"highlighted"] = node_path
	screenshot_result[&"node_class"] = node.get_class()
	_send_response(request_id, screenshot_result)


# ── Visualizer: Watch Property ──────────────────────────────────────

func _handle_watch_property(request_id: int, args: Dictionary) -> void:
	var node_path: String = args.get("node_path", "")
	var property: String = args.get("property", "")
	var duration: float = args.get("duration", 2.0)
	var interval: float = args.get("interval", 0.1)

	if node_path.is_empty() or property.is_empty():
		_send_response(request_id, {&"ok": false, &"error": "node_path and property are required"})
		return

	var node := get_node_or_null(NodePath(node_path))
	if node == null:
		_send_response(request_id, {&"ok": false, &"error": "Node not found: %s" % node_path})
		return

	if not property in node:
		_send_response(request_id, {&"ok": false, &"error": "Property '%s' not found on '%s'" % [property, node_path]})
		return

	var regex := _get_sensitive_regex()
	if regex.search(property):
		_send_response(request_id, {&"ok": false, &"error": "Cannot watch sensitive property: %s" % property})
		return

	var samples: Array[Dictionary] = []
	var elapsed := 0.0
	var start_time := Time.get_ticks_msec()

	while elapsed < duration:
		var value = _serialize_value(node.get(property))
		samples.append({
			&"t": snappedf(elapsed, 0.001),
			&"value": value,
		})
		await get_tree().create_timer(interval).timeout
		elapsed = (Time.get_ticks_msec() - start_time) / 1000.0

	_send_response(request_id, {
		&"ok": true,
		&"node_path": node_path,
		&"property": property,
		&"samples": samples,
		&"sample_count": samples.size(),
		&"duration": elapsed,
	})


# ── Visualizer: Performance Stats ───────────────────────────────────

func _handle_performance_stats(request_id: int, args: Dictionary) -> void:
	var categories: Array = args.get("categories", ["time", "memory", "objects", "physics", "rendering"])
	var stats := {}

	for cat in categories:
		match str(cat):
			"time":
				stats[&"time"] = {
					&"fps": Performance.get_monitor(Performance.TIME_FPS),
					&"frame_time_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
					&"physics_time_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
					&"navigation_time_ms": Performance.get_monitor(Performance.TIME_NAVIGATION_PROCESS) * 1000.0,
				}
			"memory":
				stats[&"memory"] = {
					&"static_mb": Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0,
					&"static_max_mb": Performance.get_monitor(Performance.MEMORY_STATIC_MAX) / 1048576.0,
					&"message_buffer_max_kb": Performance.get_monitor(Performance.MEMORY_MESSAGE_BUFFER_MAX) / 1024.0,
				}
			"objects":
				stats[&"objects"] = {
					&"count": Performance.get_monitor(Performance.OBJECT_COUNT),
					&"resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
					&"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
					&"orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
				}
			"physics":
				stats[&"physics"] = {
					&"active_objects_2d": Performance.get_monitor(Performance.PHYSICS_2D_ACTIVE_OBJECTS),
					&"collision_pairs_2d": Performance.get_monitor(Performance.PHYSICS_2D_COLLISION_PAIRS),
					&"island_count_2d": Performance.get_monitor(Performance.PHYSICS_2D_ISLAND_COUNT),
					&"active_objects_3d": Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS),
					&"collision_pairs_3d": Performance.get_monitor(Performance.PHYSICS_3D_COLLISION_PAIRS),
					&"island_count_3d": Performance.get_monitor(Performance.PHYSICS_3D_ISLAND_COUNT),
				}
			"rendering":
				stats[&"rendering"] = {
					&"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
					&"objects_in_frame": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
					&"primitives_in_frame": Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME),
					&"video_mem_mb": Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0,
					&"texture_mem_mb": Performance.get_monitor(Performance.RENDER_TEXTURE_MEM_USED) / 1048576.0,
					&"buffer_mem_mb": Performance.get_monitor(Performance.RENDER_BUFFER_MEM_USED) / 1048576.0,
				}

	_send_response(request_id, {
		&"ok": true,
		&"stats": stats,
	})


# ── Screenshot helper for visualizer responses ──────────────────────

func _capture_screenshot_for_response() -> Dictionary:
	var screenshot_dir := ".godot/mcp-screenshots/"
	var abs_dir := ProjectSettings.globalize_path("res://" + screenshot_dir)
	if not DirAccess.dir_exists_absolute(abs_dir):
		DirAccess.make_dir_recursive_absolute(abs_dir)

	var image := get_viewport().get_texture().get_image()
	if image == null:
		return {&"ok": true, &"screenshot": false}

	var timestamp := Time.get_datetime_string_from_system().replace(":", "").replace("-", "").replace("T", "_")
	var filename := "overlay_%s.png" % timestamp
	var abs_path := abs_dir.path_join(filename)

	var err := image.save_png(abs_path)
	if err != OK:
		return {&"ok": true, &"screenshot": false}

	_cleanup_screenshots(abs_dir, 10)

	return {
		&"ok": true,
		&"path": abs_path,
		&"width": image.get_width(),
		&"height": image.get_height(),
	}
