import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVendor } from '../../scripts/check-vendor.mjs';
import {
  canonical,
  classesDefinedIn,
  destinationOf,
  generate,
  importsOf,
  packageNameOf,
  rewriteAppAlias,
  stringWordsOf,
} from '../../scripts/sync-inflect-ui.mjs';

const ROOT = path.resolve(__dirname, '../..');

type Upstream = { commit: string; files: Set<string>; read: (p: string) => Buffer };

function fakeUpstream(files: Record<string, string>): Upstream {
  return {
    commit: 'a'.repeat(40),
    files: new Set(Object.keys(files)),
    read: (p: string) => {
      if (!(p in files)) throw new Error(`not upstream: ${p}`);
      return Buffer.from(files[p], 'utf8');
    },
  };
}

const BASE_FILES = {
  'packages/ui/tokens.contract.css': ':root { --bg-page: #fff; }\n',
  LICENSE: 'BUSL-1.1\n',
  'src/app/globals.css': '.glass-card { color: red; }\n',
  'messages/en.json': JSON.stringify({ common: { close: 'Close' } }),
};

const CONFIG = {
  repository: 'https://example.invalid/inflect.git',
  entries: ['src/components/ui/modal.tsx'],
  importRewrites: [],
  messages: { locales: ['en'], keys: ['common.close'] },
};

describe('the vendored tree', () => {
  it('matches its manifest', () => {
    expect(checkVendor(ROOT)).toEqual([]);
  });

  it('is pinned to a full commit sha that matches the config', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/inflect-ui/manifest.json'), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/inflect-ui.config.json'), 'utf8'));
    expect(manifest.inflectCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.inflectCommit).toBe(config.ref);
  });

  it('carries the upstream licence', () => {
    const license = fs.readFileSync(path.join(ROOT, 'vendor/inflect-ui/LICENSE'), 'utf8');
    expect(license).toContain('Business Source License 1.1');
  });

  it('imports nothing through @/ any more', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/inflect-ui/manifest.json'), 'utf8'));
    const leftovers = manifest.files
      .filter((f: { path: string }) => /\.tsx?$/.test(f.path))
      .flatMap((f: { path: string }) =>
        importsOf(fs.readFileSync(path.join(ROOT, 'vendor/inflect-ui', f.path), 'utf8'))
          .filter((i: { specifier: string }) => i.specifier.startsWith('@/'))
          .map((i: { specifier: string }) => `${f.path}: ${i.specifier}`),
      );
    expect(leftovers).toEqual([]);
  });
});

describe('check-vendor', () => {
  let scratch: string | null = null;
  afterEach(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  });

  function copyOfRepoVendor() {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-check-'));
    fs.cpSync(path.join(ROOT, 'vendor'), path.join(scratch, 'vendor'), { recursive: true });
    return scratch;
  }

  it('reports a file edited by hand', () => {
    const root = copyOfRepoVendor();
    fs.appendFileSync(path.join(root, 'vendor/inflect-ui/src/lib/cn.ts'), '// edited\n');
    expect(checkVendor(root)).toEqual(['edited: src/lib/cn.ts']);
  });

  it('reports a file added or removed', () => {
    const root = copyOfRepoVendor();
    fs.writeFileSync(path.join(root, 'vendor/inflect-ui/src/extra.ts'), 'export {};\n');
    fs.rmSync(path.join(root, 'vendor/inflect-ui/src/components/ui/card.tsx'));
    expect(checkVendor(root).sort()).toEqual(['missing: src/components/ui/card.tsx', 'not in manifest: src/extra.ts']);
  });

  it('reports a pin moved without a re-sync', () => {
    const root = copyOfRepoVendor();
    const configPath = path.join(root, 'vendor/inflect-ui.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, ref: 'b'.repeat(40) }));
    expect(checkVendor(root)[0]).toMatch(/run npm run vendor:sync/);
  });
});

describe('sync rules', () => {
  it('maps upstream paths into the vendored tree', () => {
    expect(destinationOf('packages/ui/src/lib/cn.ts')).toBe('src/lib/cn.ts');
    expect(destinationOf('src/components/ui/modal.tsx')).toBe('src/components/ui/modal.tsx');
    expect(destinationOf('src/lib/hooks/use-keyboard-inset.ts')).toBe('src/lib/hooks/use-keyboard-inset.ts');
    expect(() => destinationOf('src/app-layer/usecases/x.ts')).toThrow();
  });

  it('rewrites only the two aliases the package boundary allows', () => {
    expect(rewriteAppAlias('@/components/ui/typography')).toBe('@inflect/ui/components/ui/typography');
    expect(rewriteAppAlias('@/lib/hooks/use-keyboard-inset')).toBe('@inflect/ui/lib/hooks/use-keyboard-inset');
    expect(rewriteAppAlias('@/lib/permissions')).toBeNull();
    expect(rewriteAppAlias('@/app-layer/types')).toBeNull();
  });

  it('names the package of a bare import', () => {
    expect(packageNameOf('@radix-ui/react-dialog')).toBe('@radix-ui/react-dialog');
    expect(packageNameOf('next/navigation')).toBe('next');
    expect(packageNameOf('react')).toBe('react');
  });

  it('prefers the package copy over a re-export shim', () => {
    const files = new Set(['src/components/ui/button.tsx', 'packages/ui/src/components/ui/button.tsx']);
    expect(canonical('src/components/ui/button.tsx', files)).toBe('packages/ui/src/components/ui/button.tsx');
    expect(canonical('src/components/ui/modal.tsx', files)).toBe('src/components/ui/modal.tsx');
  });

  it('locates each import specifier exactly', () => {
    const source = `import { a } from "./x";\nexport * from '@/y';\nconst z = import("zz");`;
    for (const { specifier, pos, end } of importsOf(source)) {
      expect(source.slice(pos, end)).toBe(specifier);
    }
  });

  it('reads class names from strings, never from comments', () => {
    const words = stringWordsOf('// the glass-card recipe\nconst c = cn("p-4 md:glass-card", `x ${y} !data-table`);', 'a.tsx');
    expect(words.has('glass-card')).toBe(true);
    expect(words.has('data-table')).toBe(true);
    expect(words.has('recipe')).toBe(false);
  });

  it('reads class selectors from a stylesheet', () => {
    expect([...classesDefinedIn('.a { }\n  .b-c, .d {}\n/* .e */\n')]).toEqual(['a', 'b-c']);
  });
});

describe('generate', () => {
  const deps = new Set(['react']);

  it('rewrites allowed aliases, follows the closure and records host classes', () => {
    const upstream = fakeUpstream({
      ...BASE_FILES,
      'src/components/ui/modal.tsx': `import { Heading } from '@/components/ui/typography';\nimport { Button } from "./button";\nimport React from 'react';\nexport const c = "glass-card";\n`,
      'src/components/ui/typography.tsx': `export * from '@inflect/ui/components/ui/typography';\n`,
      'src/components/ui/button.tsx': `export * from '@inflect/ui/components/ui/button';\n`,
      'packages/ui/src/components/ui/typography.tsx': `export const Heading = 1;\n`,
      'packages/ui/src/components/ui/button.tsx': `export const Button = 1;\n`,
    });
    const out = generate(upstream, CONFIG, deps);
    expect(out.get('src/components/ui/modal.tsx').bytes.toString()).toContain(`from '@inflect/ui/components/ui/typography'`);
    expect([...out.keys()].sort()).toEqual(
      [
        'LICENSE',
        'README.md',
        'manifest.json',
        'messages/en.json',
        'src/components/ui/button.tsx',
        'src/components/ui/modal.tsx',
        'src/components/ui/typography.tsx',
        'tokens.contract.css',
      ].sort(),
    );
    // The package copies win over inflect's re-export shims.
    expect(out.get('src/components/ui/button.tsx').bytes.toString()).toBe('export const Button = 1;\n');
    const manifest = JSON.parse(out.get('manifest.json').bytes.toString());
    expect(manifest.hostClassesReferenced).toEqual({ 'glass-card': ['src/components/ui/modal.tsx'] });
  });

  it('refuses an import from outside the package boundary', () => {
    const upstream = fakeUpstream({
      ...BASE_FILES,
      'src/components/ui/modal.tsx': `import { can } from '@/lib/permissions';\n`,
    });
    expect(() => generate(upstream, CONFIG, deps)).toThrow(/outside the package boundary/);
  });

  it('refuses a bare import that is not a dependency here', () => {
    const upstream = fakeUpstream({
      ...BASE_FILES,
      'src/components/ui/modal.tsx': `import confetti from 'canvas-confetti';\n`,
    });
    expect(() => generate(upstream, CONFIG, deps)).toThrow(/canvas-confetti is imported/);
  });

  it('refuses a message key upstream does not have', () => {
    const upstream = fakeUpstream({ ...BASE_FILES, 'src/components/ui/modal.tsx': `export {};\n` });
    expect(() => generate(upstream, { ...CONFIG, messages: { locales: ['en'], keys: ['common.nope'] } }, deps)).toThrow(
      /has no key common.nope/,
    );
  });
});
