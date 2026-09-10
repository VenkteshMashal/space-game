/**
 * Deterministic entity IDs (Plan B9): IDs derive from version, seed and index; fracture children
 * extend their parent. IDs are never reused within an epoch, so a stale reference can always be
 * rejected rather than silently resolved to a different body.
 *
 * Entity keys on the wire are `uint32 id + uint16 generation + uint16 field mask` (B3), so IDs stay
 * inside 32 bits. The string form is only for authored content, tooling and debugging.
 */

const BASE = 36;

export function encodeNumericId(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`id out of uint32 range: ${value}`);
  return value;
}

export function idFromIndex(prefix: string, index: number): string {
  return `${prefix}${index.toString(BASE)}`;
}

/** Stable content ID: `version/seed/index`, e.g. `belt-1/8241/37`. */
export function contentId(version: number, seed: number, index: number): string {
  return `${version}/${seed >>> 0}/${index}`;
}

/** Fracture child of `parentId` with child index `child`; never collides with a sibling. */
export function childId(parentId: string, generation: number, child: number): string {
  return `${parentId}~${generation.toString(BASE)}.${child.toString(BASE)}`;
}

export function splitChildId(parentId: string, child: number): string {
  return `${parentId}.${child}`;
}

export function parentOf(id: string): string | null {
  const at = id.lastIndexOf('.');
  return at > 0 ? id.slice(0, at) : null;
}

/** 32-bit FNV-1a. Used for stable content hashes and seeds, never for security. */
export function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** FNV-1a over a float field, quantized so tiny FP noise cannot change an identity hash. */
export function hashNumber(hash: number, value: number, quantum = 1e-3): number {
  const quantized = Number.isFinite(value) ? Math.round(value / quantum) : 0;
  return hash32(`${hash}:${quantized}`);
}

export function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
