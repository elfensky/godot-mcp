/**
 * Dynamic port assignment for multi-project support.
 *
 * Each Godot project gets a deterministic port pair derived from its
 * canonical path via FNV-1a hash. This avoids coordination between
 * processes — the same project always maps to the same ports.
 *
 * Port range: 6505–8504 (1000 project slots, 2 ports each).
 *   ws  = BASE + (hash % SLOTS) * 2       (even offset)
 *   http = ws + 1                          (odd offset)
 */

import { realpathSync } from 'node:fs';
import { resolve, normalize } from 'node:path';

const BASE_PORT = 6505;
const SLOTS = 1000;

/** Default ports when no project path is known. */
export const DEFAULT_WS_PORT = 6505;
export const DEFAULT_HTTP_PORT = 6506;

export interface PortPair {
  ws: number;
  http: number;
}

/** Resolve symlinks and normalize a project path for consistent hashing. */
export function canonicalProjectPath(p: string): string {
  try {
    return normalize(realpathSync(resolve(p)));
  } catch {
    // Path might not exist yet (e.g. --project for a new project)
    return normalize(resolve(p));
  }
}

/** FNV-1a hash of a UTF-8 string, returning a 32-bit unsigned integer. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0; // unsigned
}

/**
 * Compute the WebSocket + HTTP port pair for a project via FNV-1a hash.
 * Returns only the hash-based ports — callers handle env var / CLI overrides.
 */
export function projectPorts(projectPath: string): PortPair {
  const canonical = canonicalProjectPath(projectPath);
  const hash = fnv1a(canonical);
  const slot = hash % SLOTS;
  const ws = BASE_PORT + slot * 2;
  return { ws, http: ws + 1 };
}
