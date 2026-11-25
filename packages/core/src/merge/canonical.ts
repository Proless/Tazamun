/**
 * JSON with object keys sorted, so two equal values always give the same string. The engine uses
 * it to tell whether a merge changed anything (ENG-8: push back only when the result differs from
 * the server copy) and the merge functions use it as a deterministic tie-break.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      // JSON.stringify drops undefined properties; do the same so {a: undefined} equals {}.
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}
