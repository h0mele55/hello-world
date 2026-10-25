/**
 * Canonical JSON: object keys sorted recursively, no whitespace, arrays in
 * order. `canonicalJson` is copied verbatim from inflect-compliance
 * `src/lib/canonical-json.ts` at commit 3e9f3ef28e18dc2be8d393502e3e5ee413f72bbd.
 *
 * That function is total: it turns `undefined`, `NaN` and `Infinity` into
 * `null` and a `Date` into `{}`, so two different values can serialise alike.
 * A commitment cannot tolerate that, so every caller here goes through
 * `strictCanonicalJson`, which refuses anything outside plain JSON first.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(',')}}`;
}

export class NonCanonicalValueError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Not canonical JSON at ${path}: ${reason}`);
    this.name = 'NonCanonicalValueError';
  }
}

/**
 * Refuses every value whose canonical form would be ambiguous: `undefined`,
 * non-finite or unsafe numbers, non-plain objects (Date, Map, class
 * instances), sparse arrays, and strings that are not well-formed Unicode.
 */
export function assertCanonicalValue(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new NonCanonicalValueError(path, 'string has a lone surrogate');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new NonCanonicalValueError(path, 'only safe integers are allowed');
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new NonCanonicalValueError(`${path}[${i}]`, 'sparse array');
      assertCanonicalValue(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new NonCanonicalValueError(path, 'not a plain object');
    }
    for (const [key, child] of Object.entries(value)) {
      if (!key.isWellFormed()) throw new NonCanonicalValueError(path, 'key has a lone surrogate');
      assertCanonicalValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new NonCanonicalValueError(path, `${typeof value} is not JSON`);
}

export function strictCanonicalJson(value: unknown): string {
  assertCanonicalValue(value);
  return canonicalJson(value);
}
