@tool
class_name MCPScriptCommands
extends MCPBaseCommandProcessor
## Script and file management commands: edit_script, validate_script,
## list_scripts, create_folder, delete_file, rename_file


func get_supported_tools() -> PackedStringArray:
	return PackedStringArray([
		"edit_script", "validate_script", "list_scripts",
		"create_folder", "delete_file", "rename_file"
	])


func process_command(tool_name: String, args: Dictionary) -> Dictionary:
	match tool_name:
		"edit_script":
			return edit_script(args)
		"validate_script":
			return validate_script(args)
		"list_scripts":
			return list_scripts(args)
		"create_folder":
			return create_folder(args)
		"delete_file":
			return delete_file(args)
		"rename_file":
			return rename_file(args)
	return {&"ok": false, &"error": "Unknown script command: " + tool_name}


func _ensure_res_path(path: String) -> String:
	if not path.begins_with("res://"):
		return "res://" + path
	return path


func _refresh_filesystem() -> void:
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if plugin:
		plugin.get_editor_interface().get_resource_filesystem().scan()


func _refresh_file(path: String) -> void:
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return
	var efs := plugin.get_editor_interface().get_resource_filesystem()
	efs.update_file(path)
	efs.update_script_classes()


# ── edit_script ─────────────────────────────────────────────────────

func edit_script(args: Dictionary) -> Dictionary:
	var edit: Dictionary = args.get(&"edit", {})
	if edit.is_empty():
		return {&"ok": false, &"error": "Missing 'edit' payload"}

	var path: String = str(edit.get(&"file", ""))
	if path.is_empty():
		return {&"ok": false, &"error": "Missing 'file' in edit"}

	path = _ensure_res_path(path)

	if not FileAccess.file_exists(path):
		return {&"ok": false, &"error": "File not found: " + path}

	var spec_type: String = str(edit.get(&"type", "snippet_replace"))
	if spec_type != "snippet_replace":
		return {&"ok": false, &"error": "Only 'snippet_replace' type is supported"}

	var old_snippet: String = str(edit.get(&"old_snippet", ""))
	var new_snippet: String = str(edit.get(&"new_snippet", ""))
	var context_before: String = str(edit.get(&"context_before", ""))
	var context_after: String = str(edit.get(&"context_after", ""))

	if old_snippet.is_empty():
		return {&"ok": false, &"error": "Missing 'old_snippet' in edit"}

	var file := FileAccess.open(path, FileAccess.READ)
	if not file:
		return {&"ok": false, &"error": "Cannot read file: " + path}
	var content := file.get_as_text()
	file.close()

	var pos := content.find(old_snippet)

	if pos == -1 and not context_before.is_empty():
		var ctx_pos := content.find(context_before)
		if ctx_pos != -1:
			var after_ctx := ctx_pos + context_before.length()
			var remaining := content.substr(after_ctx)
			var snippet_pos := remaining.find(old_snippet)
			if snippet_pos != -1:
				pos = after_ctx + snippet_pos

	if pos == -1:
		return {&"ok": false, &"error": "Could not find old_snippet in file. Make sure old_snippet matches the file content exactly."}

	var second_pos := content.find(old_snippet, pos + 1)
	if second_pos != -1 and context_before.is_empty() and context_after.is_empty():
		return {&"ok": false, &"error": "old_snippet appears multiple times. Add context_before or context_after for disambiguation."}

	var new_content := content.substr(0, pos) + new_snippet + content.substr(pos + old_snippet.length())

	file = FileAccess.open(path, FileAccess.WRITE)
	if not file:
		return {&"ok": false, &"error": "Cannot write file: " + path}
	file.store_string(new_content)
	file.close()

	var old_lines := old_snippet.split("\n")
	var new_lines := new_snippet.split("\n")
	var added := maxi(0, new_lines.size() - old_lines.size())
	var removed := maxi(0, old_lines.size() - new_lines.size())

	_refresh_file(path)

	return {
		&"ok": true,
		&"path": path,
		&"added": added,
		&"removed": removed,
		&"auto_applied": true,
		&"message": "Applied edit to %s (+%d -%d lines)" % [path, added, removed]
	}


# ── validate_script ─────────────────────────────────────────────────

func validate_script(args: Dictionary) -> Dictionary:
	var path: String = str(args.get(&"path", ""))
	if path.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'path'"}

	path = _ensure_res_path(path)

	if not FileAccess.file_exists(path):
		return {&"ok": false, &"error": "File not found: " + path}

	var file := FileAccess.open(path, FileAccess.READ)
	if not file:
		return {&"ok": false, &"error": "Cannot read file: " + path}
	var source_code := file.get_as_text()
	file.close()

	# Strip class_name to avoid false "hides global class" errors
	var validation_source := source_code
	var cn_regex := RegEx.new()
	cn_regex.compile("(?m)^class_name\\s+.+$")
	validation_source = cn_regex.sub(validation_source, "# [stripped class_name for validation]")

	var script := GDScript.new()
	script.source_code = validation_source

	var err := script.reload()

	if err != OK:
		return {
			&"ok": true,
			&"valid": false,
			&"path": path,
			&"error_code": err,
			&"message": "Script has errors. Check Godot console for details."
		}

	if not script.can_instantiate():
		return {
			&"ok": true,
			&"valid": false,
			&"path": path,
			&"message": "Script parsed but cannot be instantiated (may have dependency errors)"
		}

	return {
		&"ok": true,
		&"valid": true,
		&"path": path,
		&"message": "No syntax errors found"
	}


# ── list_scripts ────────────────────────────────────────────────────

func list_scripts(args: Dictionary) -> Dictionary:
	var scripts: Array = []
	_collect_scripts("res://", scripts)
	return {&"ok": true, &"scripts": scripts, &"count": scripts.size()}


func _collect_scripts(path: String, out: Array) -> void:
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
			_collect_scripts(full_path, out)
		elif fname.ends_with(".gd"):
			out.append(full_path)

		fname = dir.get_next()
	dir.list_dir_end()


# ── create_folder ───────────────────────────────────────────────────

func create_folder(args: Dictionary) -> Dictionary:
	var path: String = str(args.get(&"path", ""))
	if path.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'path'"}

	path = _ensure_res_path(path)

	if DirAccess.dir_exists_absolute(path):
		return {&"ok": true, &"path": path, &"message": "Directory already exists"}

	var err := DirAccess.make_dir_recursive_absolute(path)
	if err != OK:
		return {&"ok": false, &"error": "Failed to create directory: " + str(err)}

	_refresh_filesystem()
	return {&"ok": true, &"path": path, &"message": "Directory created"}


# ── delete_file ─────────────────────────────────────────────────────

func delete_file(args: Dictionary) -> Dictionary:
	var path: String = str(args.get(&"path", ""))
	var confirm: bool = bool(args.get(&"confirm", false))
	var create_backup: bool = bool(args.get(&"create_backup", true))

	if path.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'path'"}
	if not confirm:
		return {&"ok": false, &"error": "Must set confirm=true to delete"}

	path = _ensure_res_path(path)

	if not FileAccess.file_exists(path):
		return {&"ok": false, &"error": "File not found: " + path}

	if create_backup:
		DirAccess.copy_absolute(path, path + ".bak")

	var err := DirAccess.remove_absolute(path)
	if err != OK:
		return {&"ok": false, &"error": "Failed to delete file: " + str(err)}

	_refresh_filesystem()
	return {&"ok": true, &"path": path, &"message": "File deleted" + (" (backup created)" if create_backup else "")}


# ── rename_file ─────────────────────────────────────────────────────

func rename_file(args: Dictionary) -> Dictionary:
	var old_path: String = str(args.get(&"old_path", ""))
	var new_path: String = str(args.get(&"new_path", ""))

	if old_path.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'old_path'"}
	if new_path.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'new_path'"}

	old_path = _ensure_res_path(old_path)
	new_path = _ensure_res_path(new_path)

	if not FileAccess.file_exists(old_path):
		return {&"ok": false, &"error": "File not found: " + old_path}
	if FileAccess.file_exists(new_path):
		return {&"ok": false, &"error": "Target already exists: " + new_path}

	var dir_path := new_path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir_path):
		DirAccess.make_dir_recursive_absolute(dir_path)

	var err := DirAccess.rename_absolute(old_path, new_path)
	if err != OK:
		return {&"ok": false, &"error": "Failed to rename: " + str(err)}

	_refresh_filesystem()
	return {&"ok": true, &"old_path": old_path, &"new_path": new_path,
		&"message": "Renamed %s to %s" % [old_path, new_path]}
