/**
 * Runtime debugging tools for Godot MCP Server
 * Tools for inspecting the running game via EditorDebuggerPlugin bridge
 */

import type { ToolDefinition } from '../bridge/types.js';

export const runtimeTools: ToolDefinition[] = [
  {
    name: 'game_screenshot',
    description: 'Capture a screenshot of the RUNNING game\'s viewport. Returns the image inline as base64 PNG. Use after run_scene to visually verify game state, UI layout, rendering. Runtime debugging auto-enables on first call.',
    inputSchema: {
      type: 'object',
      properties: {
        node_path: {
          type: 'string',
          description: 'SubViewport node path to capture instead of main viewport. Optional.'
        }
      }
    }
  },
  {
    name: 'game_scene_tree',
    description: 'Dump the LIVE running game\'s scene tree (NOT the editor scene — use scene_tree_dump for editor). Requires a scene running via run_scene. Runtime debugging auto-enables on first call.',
    inputSchema: {
      type: 'object',
      properties: {
        max_depth: {
          type: 'number',
          description: 'Maximum tree depth. Default: 3'
        },
        max_nodes: {
          type: 'number',
          description: 'Maximum nodes to return. Default: 200.'
        }
      }
    }
  },
  {
    name: 'game_get_properties',
    description: 'Get ALL exported properties and their current RUNTIME values for a specific node in the RUNNING game. Use node paths from game_scene_tree. Sensitive properties are redacted by default.',
    inputSchema: {
      type: 'object',
      properties: {
        node_path: {
          type: 'string',
          description: 'Absolute node path (e.g., \'/root/Main/Player\')'
        }
      },
      required: ['node_path']
    }
  },
  {
    name: 'game_get_property',
    description: 'Get a SINGLE property value from a node in the RUNNING game. More efficient than game_get_properties when you know which property you need.',
    inputSchema: {
      type: 'object',
      properties: {
        node_path: {
          type: 'string',
          description: 'Absolute node path (e.g., \'/root/Main/Player\')'
        },
        property: {
          type: 'string',
          description: 'Property name (e.g., \'position\', \'health\', \'visible\')'
        }
      },
      required: ['node_path', 'property']
    }
  },
];
