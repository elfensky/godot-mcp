@tool
class_name MCPBaseCommandProcessor
extends Node
## Base class for all command processors.
##
## Subclasses override process_command() and return true if they handled
## the command, false to pass it to the next processor in the chain.

## Must be implemented by subclasses.
## Returns true if this processor handled the command, false otherwise.
func process_command(tool_name: String, args: Dictionary) -> Dictionary:
	push_error("MCPBaseCommandProcessor.process_command called directly")
	return {&"ok": false, &"error": "Not implemented"}


# ── Helper functions common to all processors ──────────────────────

## Returns the list of tool names this processor handles.
## Override in subclasses to declare which tools they support.
func get_supported_tools() -> PackedStringArray:
	return PackedStringArray()


## Check if this processor handles the given tool name.
func handles_tool(tool_name: String) -> bool:
	return tool_name in get_supported_tools()


## Get a node from the currently edited scene by path.
func _get_editor_node(path: String) -> Node:
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		print("GodotMCPPlugin not found in Engine metadata")
		return null

	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()

	if not edited_scene_root:
		print("No edited scene found")
		return null

	if path == "/root" or path == "":
		return edited_scene_root

	if path.begins_with("/root/"):
		path = path.substr(6)
	elif path.begins_with("/"):
		path = path.substr(1)

	return edited_scene_root.get_node_or_null(path)


## Mark the current scene as modified in the editor.
func _mark_scene_modified() -> void:
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return

	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()

	if edited_scene_root:
		editor_interface.mark_scene_as_unsaved()


## Access the EditorUndoRedoManager.
func _get_undo_redo():
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin or not plugin.has_method("get_undo_redo"):
		print("Cannot access UndoRedo from plugin")
		return null
	return plugin.get_undo_redo()


## Parse a string value into a proper Godot type (Vector2, Color, etc.).
func _parse_property_value(value):
	if typeof(value) == TYPE_STRING and (
		value.begins_with("Vector") or
		value.begins_with("Transform") or
		value.begins_with("Rect") or
		value.begins_with("Color") or
		value.begins_with("Quat") or
		value.begins_with("Basis") or
		value.begins_with("Plane") or
		value.begins_with("AABB") or
		value.begins_with("Projection") or
		value.begins_with("Callable") or
		value.begins_with("Signal") or
		value.begins_with("PackedVector") or
		value.begins_with("PackedString") or
		value.begins_with("PackedFloat") or
		value.begins_with("PackedInt") or
		value.begins_with("PackedColor") or
		value.begins_with("PackedByteArray") or
		value.begins_with("Dictionary") or
		value.begins_with("Array")
	):
		var expression = Expression.new()
		var error = expression.parse(value, [])

		if error == OK:
			var result = expression.execute([], null, true)
			if not expression.has_execute_failed():
				return result

	return value
