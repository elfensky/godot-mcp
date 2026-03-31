/**
 * Daemon discovery via .godot/mcp-daemon.json files.
 *
 * When an HTTP daemon starts for a project, it writes a small JSON file
 * so that shims and plugins can find the running instance without
 * guessing ports.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface DaemonInfo {
  pid: number;
  httpPort: number;
  wsPort: number;
  projectPath: string;
  startedAt: string;
}

function daemonFilePath(projectPath: string): string {
  return join(projectPath, '.godot', 'mcp-daemon.json');
}

/** Write the daemon discovery file for a project. */
export function writeDaemonFile(projectPath: string, info: Omit<DaemonInfo, 'startedAt'>): void {
  const filePath = daemonFilePath(projectPath);
  const data: DaemonInfo = { ...info, startedAt: new Date().toISOString() };
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/** Read and validate the daemon file. Returns null if missing, stale, or for a different project. */
export function readDaemonFile(projectPath: string): DaemonInfo | null {
  const filePath = daemonFilePath(projectPath);
  if (!existsSync(filePath)) return null;

  let data: DaemonInfo;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  // Validate PID is alive
  try {
    process.kill(data.pid, 0); // signal 0 = existence check
  } catch {
    // Process is dead — clean up stale file
    removeDaemonFile(projectPath);
    return null;
  }

  return data;
}

/** Remove the daemon discovery file. */
export function removeDaemonFile(projectPath: string): void {
  const filePath = daemonFilePath(projectPath);
  try {
    unlinkSync(filePath);
  } catch {
    // Already gone
  }
}

/**
 * Walk up from startDir looking for a directory containing project.godot.
 * Returns the project root path, or null if not found.
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 50; i++) {
    const marker = join(dir, 'project.godot');
    try {
      if (statSync(marker).isFile()) return dir;
    } catch {
      // Not found, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}
