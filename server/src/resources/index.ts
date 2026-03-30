/**
 * Resource registry — aggregates all MCP resource definitions.
 *
 * Resources are read-only data exposed to AI clients for context gathering
 * without executing tools. Each resource is backed by a Godot bridge call.
 *
 * Resource URI scheme: godot://
 *   godot://project/settings     — project metadata and settings
 *   godot://project/input-map    — input action mappings
 *   godot://scenes               — list of all .tscn files
 *   godot://scene/{path}         — scene structure (e.g. godot://scene/res://main.tscn)
 *   godot://scripts              — list of all .gd files
 *   godot://editor/scene-tree    — current editor scene tree
 *   godot://editor/errors        — latest editor errors/warnings
 *   godot://editor/console       — latest console output
 */

import type { GodotBridge } from '../bridge/godot-bridge.js';

// ── Types ──────────────────────────────────────────────────────────

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

// ── Static resources (no URI parameters) ───────────────────────────

export const staticResources: ResourceDefinition[] = [
  {
    uri: 'godot://project/settings',
    name: 'Project Settings',
    description: 'Godot project metadata: main scene, window size, physics, rendering, and display settings.',
    mimeType: 'application/json'
  },
  {
    uri: 'godot://project/input-map',
    name: 'Input Map',
    description: 'All input actions and their key/mouse/gamepad bindings.',
    mimeType: 'application/json'
  },
  {
    uri: 'godot://scenes',
    name: 'Scene List',
    description: 'All .tscn scene files in the project with paths.',
    mimeType: 'application/json'
  },
  {
    uri: 'godot://scripts',
    name: 'Script List',
    description: 'All .gd script files in the project with metadata.',
    mimeType: 'application/json'
  },
  {
    uri: 'godot://editor/scene-tree',
    name: 'Editor Scene Tree',
    description: 'Node hierarchy of the currently edited scene.',
    mimeType: 'application/json'
  },
  {
    uri: 'godot://editor/errors',
    name: 'Editor Errors',
    description: 'Latest errors and warnings from the editor output panel.',
    mimeType: 'application/json'
  },
  {
    uri: 'godot://editor/console',
    name: 'Console Log',
    description: 'Latest console output from the editor.',
    mimeType: 'application/json'
  }
];

// ── Template resources (parameterized URIs) ────────────────────────

export const resourceTemplates: ResourceTemplateDefinition[] = [
  {
    uriTemplate: 'godot://scene/{path}',
    name: 'Scene Structure',
    description: 'Parse and return the node hierarchy of a specific scene file. Use the full res:// path as the parameter (e.g. godot://scene/res://scenes/main.tscn).',
    mimeType: 'application/json'
  },
  {
    uriTemplate: 'godot://file/{path}',
    name: 'File Contents',
    description: 'Read the contents of a project file. Use the full res:// path (e.g. godot://file/res://scripts/player.gd).',
    mimeType: 'text/plain'
  }
];

// ── Resource reader — maps URIs to Godot bridge calls ──────────────

/**
 * Read a resource by URI, delegating to the Godot bridge.
 * Returns the resource content as a string.
 */
export async function readResource(
  uri: string,
  godotBridge: GodotBridge
): Promise<{ content: string; mimeType: string }> {
  if (!godotBridge.isConnected()) {
    throw new Error('Godot editor is not connected. Open a project with the MCP plugin enabled.');
  }

  // Static resource routes
  if (uri === 'godot://project/settings') {
    const result = await godotBridge.invokeTool('get_project_settings', {});
    return { content: JSON.stringify(result, null, 2), mimeType: 'application/json' };
  }

  if (uri === 'godot://project/input-map') {
    const result = await godotBridge.invokeTool('get_input_map', {});
    return { content: JSON.stringify(result, null, 2), mimeType: 'application/json' };
  }

  if (uri === 'godot://scenes') {
    const result = await godotBridge.invokeTool('list_dir', { path: 'res://', recursive: true, filter: '*.tscn' });
    return { content: JSON.stringify(result, null, 2), mimeType: 'application/json' };
  }

  if (uri === 'godot://scripts') {
    const result = await godotBridge.invokeTool('list_scripts', {});
    return { content: JSON.stringify(result, null, 2), mimeType: 'application/json' };
  }

  if (uri === 'godot://editor/scene-tree') {
    const result = await godotBridge.invokeTool('scene_tree_dump', {});
    return { content: JSON.stringify(result, null, 2), mimeType: 'application/json' };
  }

  if (uri === 'godot://editor/errors') {
    const result = await godotBridge.invokeTool('get_errors', {});
    return { content: JSON.stringify(result, null, 2), mimeType: 'application/json' };
  }

  if (uri === 'godot://editor/console') {
    const result = await godotBridge.invokeTool('get_console_log', {});
    return { content: JSON.stringify(result, null, 2), mimeType: 'application/json' };
  }

  // Template resource routes
  const sceneMatch = uri.match(/^godot:\/\/scene\/(.+)$/);
  if (sceneMatch) {
    const scenePath = sceneMatch[1];
    const result = await godotBridge.invokeTool('read_scene', { path: scenePath });
    return { content: JSON.stringify(result, null, 2), mimeType: 'application/json' };
  }

  const fileMatch = uri.match(/^godot:\/\/file\/(.+)$/);
  if (fileMatch) {
    const filePath = fileMatch[1];
    const result = await godotBridge.invokeTool('read_file', { path: filePath });
    return { content: JSON.stringify(result, null, 2), mimeType: 'text/plain' };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}
