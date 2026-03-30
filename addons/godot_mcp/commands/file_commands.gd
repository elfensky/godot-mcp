@tool
class_name MCPFileCommands
extends MCPBaseCommandProcessor
## File operation commands: list_dir, read_file, search_project, create_script

const DEFAULT_MAX_BYTES := 200_000
const DEFAULT_MAX_RESULTS := 200
const MAX_TRAVERSAL_DEPTH := 20
const _SKIP_EXTENSIONS: Dictionary = {
	".import": true, ".png": true, ".jpg": true, ".jpeg": true,
	".webp": true, ".svg": true, ".ogg": true, ".wav": true,
	".mp3": true, ".escn": true, ".glb": true, ".gltf": true,
	".uid": true,
}


func get_supported_tools() -> PackedStringArray:
	return PackedStringArray([
		"list_dir", "read_file", "search_project", "create_script"
	])


func process_command(tool_name: String, args: Dictionary) -> Dictionary:
	match tool_name:
		"list_dir":
			return list_dir(args)
		"read_file":
			return read_file(args)
		"search_project":
			return search_project(args)
		"create_script":
			return create_script(args)
	return {&"ok": false, &"error": "Unknown file command: " + tool_name}


func list_dir(args: Dictionary) -> Dictionary:
	var root: String = str(args.get(&"root", "res://"))
	var include_hidden: bool = bool(args.get(&"include_hidden", false))

	if not root.begins_with("res://"):
		root = "res://" + root

	var dir := DirAccess.open(root)
	if dir == null:
		return {&"ok": false, &"error": "Cannot open directory: " + root}

	var files: PackedStringArray = []
	var folders: PackedStringArray = []

	dir.list_dir_begin()
	var fname := dir.get_next()
	while fname != "":
		if not include_hidden and fname.begins_with("."):
			fname = dir.get_next()
			continue
		if fname.ends_with(".uid"):
			fname = dir.get_next()
			continue

		if dir.current_is_dir():
			folders.append(fname)
		else:
			files.append(fname)
		fname = dir.get_next()
	dir.list_dir_end()

	files.sort()
	folders.sort()

	return {
		&"ok": true,
		&"path": root,
		&"files": files,
		&"folders": folders,
		&"total": files.size() + folders.size()
	}


func read_file(args: Dictionary) -> Dictionary:
	var path: String = str(args.get(&"path", ""))
	var start_line: int = int(args.get(&"start_line", 1))
	var end_line: int = int(args.get(&"end_line", 0))
	var max_bytes: int = int(args.get(&"max_bytes", DEFAULT_MAX_BYTES))

	if path.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'path' parameter"}

	if not path.begins_with("res://"):
		path = "res://" + path

	if not FileAccess.file_exists(path):
		return {&"ok": false, &"error": "File not found: " + path}

	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return {&"ok": false, &"error": "Cannot open file: " + path}

	var content: String
	var line_count: int = 0

	if end_line <= 0 and start_line <= 1:
		var size := mini(max_bytes, file.get_length())
		content = file.get_buffer(size).get_string_from_utf8()
		line_count = content.count("\n") + 1
	else:
		var lines: Array = []
		var current_line := 0
		var total_bytes := 0

		while not file.eof_reached():
			var line := file.get_line()
			current_line += 1

			if current_line < start_line:
				continue
			if end_line > 0 and current_line > end_line:
				break

			lines.append(line)
			total_bytes += line.length() + 1

			if total_bytes > max_bytes:
				break

		content = "\n".join(lines)
		line_count = lines.size()

	file.close()

	return {
		&"ok": true,
		&"path": path,
		&"content": content,
		&"line_count": line_count,
		&"range": [start_line, end_line] if end_line > 0 else null
	}


func search_project(args: Dictionary) -> Dictionary:
	var query: String = str(args.get(&"query", ""))
	var glob_filter: String = str(args.get(&"glob", ""))
	var max_results: int = int(args.get(&"max_results", DEFAULT_MAX_RESULTS))
	var case_sensitive: bool = bool(args.get(&"case_sensitive", false))

	if query.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'query' parameter"}

	var search_query := query if case_sensitive else query.to_lower()
	var files := _collect_files("res://", glob_filter)
	var matches: Array = []

	for file_path: String in files:
		if matches.size() >= max_results:
			break

		var file := FileAccess.open(file_path, FileAccess.READ)
		if file == null:
			continue

		var content := file.get_as_text()
		file.close()

		var search_content := content if case_sensitive else content.to_lower()
		if search_content.find(search_query) == -1:
			continue

		var lines := content.split("\n")
		for i: int in range(lines.size()):
			var line := lines[i]
			var search_line := line if case_sensitive else line.to_lower()
			if search_line.find(search_query) != -1:
				matches.append({
					&"file": file_path,
					&"line": i + 1,
					&"content": line.strip_edges()
				})
				if matches.size() >= max_results:
					break

	return {
		&"ok": true,
		&"query": query,
		&"matches": matches,
		&"total_matches": matches.size(),
		&"truncated": matches.size() >= max_results
	}


func create_script(args: Dictionary) -> Dictionary:
	var path: String = str(args.get(&"path", ""))
	var content: String = str(args.get(&"content", ""))

	if path.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'path' parameter"}

	if not path.begins_with("res://"):
		path = "res://" + path

	if not "." in path.get_file():
		path += ".gd"

	if FileAccess.file_exists(path):
		return {&"ok": false, &"error": "File already exists: " + path}

	var dir_path := path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir_path):
		var err := DirAccess.make_dir_recursive_absolute(dir_path)
		if err != OK:
			return {&"ok": false, &"error": "Could not create directory: " + dir_path}

	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return {&"ok": false, &"error": "Could not create file: " + path}

	file.store_string(content)
	file.close()

	_refresh_filesystem()

	return {
		&"ok": true,
		&"path": path,
		&"size_bytes": content.length(),
		&"message": "Script created successfully"
	}


# ── Internal helpers ────────────────────────────────────────────────

func _collect_files(path: String, glob_filter: String) -> PackedStringArray:
	var result: PackedStringArray = []
	_collect_files_recursive(path, glob_filter, result)
	return result


func _collect_files_recursive(path: String, glob_filter: String, out: PackedStringArray, depth: int = 0) -> void:
	if depth >= MAX_TRAVERSAL_DEPTH:
		return

	var dir := DirAccess.open(path)
	if dir == null:
		return

	dir.list_dir_begin()
	var fname := dir.get_next()
	while fname != "":
		if fname.begins_with("."):
			fname = dir.get_next()
			continue

		var full_path := path.path_join(fname)

		if dir.current_is_dir():
			_collect_files_recursive(full_path, glob_filter, out, depth + 1)
		else:
			var ext := "." + fname.get_extension().to_lower()
			if not _SKIP_EXTENSIONS.has(ext):
				if glob_filter.is_empty() or _matches_glob(full_path, glob_filter):
					out.append(full_path)

		fname = dir.get_next()
	dir.list_dir_end()


func _matches_glob(path: String, pattern: String) -> bool:
	if pattern.begins_with("**/"):
		var ext := pattern.substr(3)
		return path.ends_with(ext.replace("*", ""))
	if pattern.begins_with("*."):
		return path.ends_with(pattern.substr(1))
	return path.find(pattern) != -1


func _refresh_filesystem() -> void:
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if plugin:
		plugin.get_editor_interface().get_resource_filesystem().scan()
