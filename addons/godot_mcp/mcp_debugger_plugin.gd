extends EditorDebuggerPlugin
## Editor-side bridge to the running game via Godot's debugger message channel.
##
## Extends RefCounted (NOT Node) — has no scene tree access.
## Uses Engine.get_main_loop() cast to SceneTree for frame polling.

var _active_session_id: int = -1
var _session_active: bool = false
var _next_request_id: int = 0
var _pending_requests: Dictionary = {}


func _has_capture(capture: String) -> bool:
	return capture == "mcp"


func _capture(message: String, data: Array, session_id: int) -> bool:
	if message == "mcp:response" and data.size() >= 2:
		var request_id: int = data[0]
		if _pending_requests.has(request_id):
			_pending_requests[request_id].response = data[1]
			_pending_requests[request_id].completed = true
		return true
	return false


func _setup_session(session_id: int) -> void:
	var session = get_session(session_id)
	session.started.connect(_on_session_started.bind(session_id))
	session.stopped.connect(_on_session_stopped.bind(session_id))


func _on_session_started(session_id: int) -> void:
	if _session_active and _active_session_id != session_id:
		push_warning("[Godot MCP] Multiple debug sessions detected; using session %d" % session_id)
	_active_session_id = session_id
	_session_active = true


func _on_session_stopped(session_id: int) -> void:
	if session_id == _active_session_id:
		_session_active = false
		for req_id in _pending_requests:
			_pending_requests[req_id].completed = true
			_pending_requests[req_id].response = {&"ok": false, &"error": "Debug session ended"}


func has_active_session() -> bool:
	return _session_active


func send_command(command: String, args: Dictionary, timeout_sec: float = 20.0) -> Dictionary:
	if not has_active_session():
		return {&"ok": false, &"error": "No active debug session — is the game running?"}

	var request_id := _next_request_id
	_next_request_id += 1
	_pending_requests[request_id] = {&"response": null, &"completed": false}

	get_session(_active_session_id).send_message("mcp:command", [request_id, command, args])

	var tree := Engine.get_main_loop() as SceneTree
	var elapsed := 0.0
	while not _pending_requests[request_id].completed and elapsed < timeout_sec:
		await tree.process_frame
		elapsed += tree.root.get_process_delta_time()

	var result: Dictionary
	if _pending_requests[request_id].completed:
		result = _pending_requests[request_id].response
		if result == null:
			result = {&"ok": false, &"error": "Game returned null response"}
	else:
		result = {&"ok": false, &"error": "Timeout waiting for game response after %.0fs" % timeout_sec}

	_pending_requests.erase(request_id)
	return result


func cancel_all_pending() -> void:
	for req_id in _pending_requests:
		_pending_requests[req_id].completed = true
		_pending_requests[req_id].response = {&"ok": false, &"error": "Request cancelled"}
