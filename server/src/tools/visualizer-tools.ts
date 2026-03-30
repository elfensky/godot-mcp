/**
 * Visualizer tools for Godot MCP Server
 * Tools for debug drawing, overlay, and visual inspection of the running game.
 * All commands execute in the running game via EditorDebuggerPlugin.
 */

import type { ToolDefinition } from '../bridge/types.js';

export const visualizerTools: ToolDefinition[] = [
  {
    name: 'debug_draw_overlay',
    description: 'Draw debug shapes on the RUNNING game viewport. Supports rectangles, circles, lines, arrows, and labels. Shapes auto-expire after duration seconds. Use to visualize bounding boxes, highlight areas, trace paths, or annotate the game view. Takes a screenshot after drawing so you can see the result.',
    inputSchema: {
      type: 'object',
      properties: {
        shapes: {
          type: 'array',
          description: 'Array of shape objects to draw. Each shape has: type ("rect", "circle", "line", "arrow", "label"), position (Vector2 as [x,y]), and type-specific fields.',
          items: {
            type: 'object',
            description: 'Shape: {type, position:[x,y], size:[w,h], radius, end:[x,y], text, color:"#RRGGBB", thickness:2}'
          }
        },
        duration: {
          type: 'number',
          description: 'Seconds before shapes auto-clear. Default: 3.0. Use 0 for persistent (until clear_debug_overlay).'
        },
        clear_existing: {
          type: 'boolean',
          description: 'Clear existing overlays before drawing new ones. Default: true.'
        }
      },
      required: ['shapes']
    }
  },
  {
    name: 'clear_debug_overlay',
    description: 'Remove all debug draw overlays from the running game.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'highlight_node',
    description: 'Highlight a specific node in the RUNNING game with a colored outline/overlay. Useful for visually identifying nodes by path. Takes a screenshot after highlighting so you can see the result.',
    inputSchema: {
      type: 'object',
      properties: {
        node_path: {
          type: 'string',
          description: 'Absolute node path (e.g., "/root/Main/Player")'
        },
        color: {
          type: 'string',
          description: 'Highlight color as hex string. Default: "#FF0000" (red).'
        },
        duration: {
          type: 'number',
          description: 'Seconds to show highlight. Default: 3.0.'
        }
      },
      required: ['node_path']
    }
  },
  {
    name: 'watch_property',
    description: 'Watch a node property in the RUNNING game, sampling its value over time. Returns an array of timestamped values. Use to observe how position, health, velocity, or other values change during gameplay.',
    inputSchema: {
      type: 'object',
      properties: {
        node_path: {
          type: 'string',
          description: 'Absolute node path (e.g., "/root/Main/Player")'
        },
        property: {
          type: 'string',
          description: 'Property name to watch (e.g., "position", "health")'
        },
        duration: {
          type: 'number',
          description: 'How many seconds to sample. Default: 2.0.'
        },
        interval: {
          type: 'number',
          description: 'Sampling interval in seconds. Default: 0.1 (10 samples/sec).'
        }
      },
      required: ['node_path', 'property']
    }
  },
  {
    name: 'performance_stats',
    description: 'Get current performance metrics from the RUNNING game: FPS, frame time, physics time, draw calls, objects, memory usage, and more. Use to diagnose performance issues.',
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'array',
          description: 'Which categories to include: "time", "memory", "objects", "physics", "rendering". Default: all.',
          items: {
            type: 'string',
            description: 'Category name: "time", "memory", "objects", "physics", or "rendering"'
          }
        }
      }
    }
  }
];
