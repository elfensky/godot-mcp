@tool
class_name MCPCommandHandler
extends Node
## Routes tool calls to the appropriate command processor.
##
## Uses Chain of Responsibility: iterates registered processors and
## delegates to the first one that handles the tool name.

var _command_processors: Array[MCPBaseCommandProcessor] = []


func _ready() -> void:
	print("[CommandHandler] Initializing...")
	await get_tree().process_frame
	_initialize_processors()
	print("[CommandHandler] Ready with %d processors" % _command_processors.size())


func _initialize_processors() -> void:
	_register_processor(MCPFileCommands.new(), "FileCommands")
	_register_processor(MCPSceneCommands.new(), "SceneCommands")
	_register_processor(MCPScriptCommands.new(), "ScriptCommands")
	_register_processor(MCPProjectCommands.new(), "ProjectCommands")
	_register_processor(MCPAssetCommands.new(), "AssetCommands")
	_register_processor(MCPRuntimeCommands.new(), "RuntimeCommands")


func _register_processor(processor: MCPBaseCommandProcessor, node_name: String) -> void:
	processor.name = node_name
	_command_processors.append(processor)
	add_child(processor)


## Get a registered processor by its node name.
func get_processor(node_name: String) -> MCPBaseCommandProcessor:
	for processor in _command_processors:
		if processor.name == node_name:
			return processor
	return null


## Execute a tool command by finding the right processor.
## Returns a Dictionary with &"ok": bool and either result data or &"error": String.
func execute_command(tool_name: String, args: Dictionary) -> Dictionary:
	for processor in _command_processors:
		if processor.handles_tool(tool_name):
			return await processor.process_command(tool_name, args)

	return {&"ok": false, &"error": "Unknown tool: %s" % tool_name}
