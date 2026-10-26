import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * src/lib/verify-core runs in the browser (and the standalone verifier), so
 * nothing it imports, directly or through other modules, may need Node or the
 * server: no `node:` modules or Node built-ins, no database, no secrets, no
 * `Buffer`. Bare package imports are allowed only from this list: asn1js and
 * pkijs read a copy's electronic seal (seal.ts, #120), with WebCrypto.
 */
const ALLOWED_PACKAGES = new Set(['viem', 'zod', 'asn1js', 'pkijs']);
const ROOT = path.resolve(import.meta.dirname, '..', '..');

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(ROOT, 'src', specifier.slice(2)) : path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function closure(entry: string) {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const offenders: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    if (/\bBuffer\b/.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) offenders.push(`${path.relative(ROOT, file)} uses Buffer`);
    for (const [, specifier] of source.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)) {
      if (!specifier) continue;
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        const resolved = resolveLocal(file, specifier);
        if (!resolved) offenders.push(`${path.relative(ROOT, file)} imports unresolvable ${specifier}`);
        else queue.push(resolved);
      } else {
        packages.add(specifier.split('/')[0]);
      }
    }
  }
  return { files: [...seen].map((f) => path.relative(ROOT, f)).sort(), packages: [...packages].sort(), offenders };
}

describe.each(['index.ts', 'seal.ts'])('the verify-core boundary, from %s', (entry) => {
  const { files, packages, offenders } = closure(path.join(ROOT, 'src', 'lib', 'verify-core', entry));

  it('imports only browser-safe packages', () => {
    expect(packages.filter((p) => !ALLOWED_PACKAGES.has(p))).toEqual([]);
  });

  it('reaches no server module and uses no Buffer', () => {
    expect(offenders).toEqual([]);
    expect(files.filter((f) => /server|db\.ts|storage|sealed|keys|auth|anchoring\/|pdf\/parse/.test(f))).toEqual([]);
  });

  it.runIf(entry === 'index.ts')('covers the opinion code the server commits with', () => {
    expect(files).toEqual(expect.arrayContaining(['src/lib/opinion/locate.ts', 'src/lib/opinion/normalise.ts', 'src/lib/verify-core/lines.mjs', 'src/lib/verify-core/commitment.ts']));
  });
});
