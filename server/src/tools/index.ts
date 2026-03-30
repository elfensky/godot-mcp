/**
 * Tool registry — aggregates all tool definitions.
 *
 * Each tool module exports a ToolDefinition[] array.
 * Add new tool modules here as they are implemented.
 */

import type { ToolDefinition } from './types.js';

import { fileTools } from './file-tools.js';
import { sceneTools } from './scene-tools.js';
import { scriptTools } from './script-tools.js';
import { projectTools } from './project-tools.js';
import { assetTools } from './asset-tools.js';
import { runtimeTools } from './runtime-tools.js';
import { visualizerTools } from './visualizer-tools.js';

export const allTools: ToolDefinition[] = [
  ...fileTools,
  ...sceneTools,
  ...scriptTools,
  ...projectTools,
  ...assetTools,
  ...runtimeTools,
  ...visualizerTools,
];

export function toolExists(toolName: string): boolean {
  return allTools.some(t => t.name === toolName);
}
