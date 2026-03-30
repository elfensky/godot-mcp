/**
 * Asset generation tools for Godot MCP Server
 * Tools for generating 2D assets via SVG.
 */

import type { ToolDefinition } from '../bridge/types.js';

export const assetTools: ToolDefinition[] = [
  {
    name: 'generate_2d_asset',
    description: 'Generate a 2D sprite/texture from SVG code and save as PNG. Use for custom visuals (characters, objects, backgrounds, UI). Returns resource_path and dimensions.',
    inputSchema: {
      type: 'object',
      properties: {
        svg_code: {
          type: 'string',
          description: 'Complete SVG code string with <svg> tags including width/height.'
        },
        filename: {
          type: 'string',
          description: 'Filename for the asset (saved as .png). Example: "player_sprite.png"'
        },
        save_path: {
          type: 'string',
          description: 'Godot resource path to save (default: res://assets/generated/)'
        }
      },
      required: ['svg_code', 'filename']
    }
  }
];
