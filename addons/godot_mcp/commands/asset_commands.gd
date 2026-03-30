@tool
class_name MCPAssetCommands
extends MCPBaseCommandProcessor
## Asset generation commands: generate_2d_asset


func get_supported_tools() -> PackedStringArray:
	return PackedStringArray(["generate_2d_asset"])


func process_command(tool_name: String, args: Dictionary) -> Dictionary:
	match tool_name:
		"generate_2d_asset":
			return generate_2d_asset(args)
	return {&"ok": false, &"error": "Unknown asset command: " + tool_name}


func generate_2d_asset(args: Dictionary) -> Dictionary:
	var svg_code: String = str(args.get(&"svg_code", ""))
	var filename: String = str(args.get(&"filename", ""))
	var save_path: String = str(args.get(&"save_path", "res://assets/generated/"))

	if svg_code.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'svg_code'"}
	if filename.strip_edges().is_empty():
		return {&"ok": false, &"error": "Missing 'filename'"}

	if not filename.ends_with(".png"):
		filename += ".png"

	if not save_path.begins_with("res://"):
		save_path = "res://" + save_path
	if not save_path.ends_with("/"):
		save_path += "/"

	if not DirAccess.dir_exists_absolute(save_path):
		DirAccess.make_dir_recursive_absolute(save_path)

	# Parse SVG dimensions
	var width := 64
	var height := 64

	var w_start := svg_code.find("width=\"")
	if w_start != -1:
		var w_val := svg_code.substr(w_start + 7)
		var w_end := w_val.find("\"")
		if w_end != -1:
			width = int(w_val.substr(0, w_end))

	var h_start := svg_code.find("height=\"")
	if h_start != -1:
		var h_val := svg_code.substr(h_start + 8)
		var h_end := h_val.find("\"")
		if h_end != -1:
			height = int(h_val.substr(0, h_end))

	# Save SVG to temp file, then load as image
	var temp_svg_path := "user://temp_asset.svg"
	var svg_file := FileAccess.open(temp_svg_path, FileAccess.WRITE)
	if not svg_file:
		return {&"ok": false, &"error": "Failed to create temp SVG file"}
	svg_file.store_string(svg_code)
	svg_file.close()

	var image := Image.new()
	var err := image.load(temp_svg_path)
	if err != OK:
		image = Image.create(width, height, false, Image.FORMAT_RGBA8)
		image.fill(Color(1, 0, 1, 1))  # Magenta fallback = something went wrong
		print("[MCP] Warning: Could not render SVG, created fallback image")

	DirAccess.remove_absolute(temp_svg_path)

	# Save as PNG
	var full_path := save_path + filename
	var global_path := ProjectSettings.globalize_path(full_path)
	err = image.save_png(global_path)
	if err != OK:
		return {&"ok": false, &"error": "Failed to save PNG: " + str(err)}

	_refresh_filesystem()

	return {
		&"ok": true,
		&"resource_path": full_path,
		&"dimensions": {&"width": width, &"height": height},
		&"message": "Generated %s (%dx%d)" % [full_path, width, height],
	}


func _refresh_filesystem() -> void:
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return
	plugin.get_editor_interface().get_resource_filesystem().scan()
