import { createHash } from 'crypto';

/** SHA-256 of a string, returns hex. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 of a Uint8Array, returns hex. */
export function sha256Bytes(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Deterministic canonical JSON: sorted keys, no extra whitespace. */
export function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(obj));
}

function sortKeysDeep(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val !== null && typeof val === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as object).sort()) {
      sorted[k] = sortKeysDeep((val as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return val;
}
