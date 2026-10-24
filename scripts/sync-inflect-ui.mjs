#!/usr/bin/env node
/**
 * Vendors Inflect's shared UI into vendor/inflect-ui/ at one pinned commit.
 *
 * npm cannot install a subdirectory of a git repository, and @inflect/ui ships
 * TypeScript sources with no build, so this repo copies them. What is copied is
 * the IMPORT CLOSURE of the entry points in vendor/inflect-ui.config.json, not
 * the whole package: a file nobody imports would only add dependencies.
 *
 * Usage:
 *   node scripts/sync-inflect-ui.mjs                 # re-sync at the pinned ref
 *   node scripts/sync-inflect-ui.mjs --ref <sha>     # move the pin (its own PR)
 *   node scripts/sync-inflect-ui.mjs --source <dir>  # read from a local clone
 *   node scripts/sync-inflect-ui.mjs --check         # write nothing; fail if the
 *                                                    # vendored tree differs from
 *                                                    # what upstream would produce
 *
 * Rules it enforces, each a hard failure:
 *   - every vendored file resolves inside the package boundary: an `@/` import
 *     that is not `@/components/ui/*` or `@/lib/hooks/*` is refused;
 *   - every bare import is a runtime dependency in this repo's package.json;
 *   - two upstream files never land on one vendored path.
 *
 * Files from inflect's `packages/ui` are copied byte for byte. Files still in
 * inflect's `src/` get their `@/components/ui/*` and `@/lib/hooks/*` imports
 * rewritten to `@inflect/ui/...`, plus any rewrite the config declares; the
 * manifest records both hashes for those.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'vendor/inflect-ui.config.json');
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor/inflect-ui');
const MANIFEST_NAME = 'manifest.json';
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

class SyncError extends Error {}

function parseArgs(argv) {
  const args = { ref: null, source: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ref') args.ref = argv[++i];
    else if (arg === '--source') args.source = argv[++i];
    else if (arg === '--check') args.check = true;
    else throw new SyncError(`Unknown argument: ${arg}`);
  }
  return args;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
}

/** A read-only view of the upstream tree at one commit. */
function openUpstream({ repository, ref, source }) {
  let dir = source;
  let dispose = () => {};
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflect-ui-'));
    const created = dir;
    dispose = () => fs.rmSync(created, { recursive: true, force: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', repository);
    git(dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', ref);
  }
  const commit = git(dir, 'rev-parse', '--verify', `${ref}^{commit}`).toString().trim();
  const listed = git(dir, 'ls-tree', '-r', '--name-only', commit, '--', 'packages/ui', 'src/components/ui', 'src/lib/hooks', 'src/app/globals.css', 'messages', 'LICENSE')
    .toString()
    .split('\n')
    .filter(Boolean);
  const files = new Set(listed);
  const read = (p) => {
    if (!files.has(p)) throw new SyncError(`Not in upstream at ${commit}: ${p}`);
    return git(dir, 'show', `${commit}:${p}`);
  };
  return { commit, files, read, dispose };
}

/**
 * A file still under inflect's src/ that has a twin inside packages/ui is a
 * re-export shim (e.g. src/components/ui/button.tsx). The package copy wins.
 */
export function canonical(upstreamPath, files) {
  for (const [appPrefix, pkgPrefix] of [
    ['src/components/ui/', 'packages/ui/src/components/ui/'],
    ['src/lib/hooks/', 'packages/ui/src/lib/hooks/'],
  ]) {
    if (upstreamPath.startsWith(appPrefix)) {
      const twin = pkgPrefix + upstreamPath.slice(appPrefix.length);
      if (files.has(twin)) return twin;
    }
  }
  return upstreamPath;
}

function resolveCandidate(base, files) {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = path.posix.normalize(base + suffix);
    const preferred = canonical(candidate, files);
    if (files.has(preferred)) return preferred;
    if (files.has(candidate)) return candidate;
  }
  return null;
}

/** Where an upstream file lands, relative to vendor/inflect-ui/. */
export function destinationOf(upstreamPath) {
  if (upstreamPath.startsWith('packages/ui/src/')) return `src/${upstreamPath.slice('packages/ui/src/'.length)}`;
  if (upstreamPath.startsWith('src/components/ui/')) return upstreamPath;
  if (upstreamPath.startsWith('src/lib/hooks/')) return `src/lib/hooks/${upstreamPath.slice('src/lib/hooks/'.length)}`;
  throw new SyncError(`No vendored destination for ${upstreamPath}`);
}

/** Package-name part of a bare specifier: `@radix-ui/react-dialog/x` -> `@radix-ui/react-dialog`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** How an `@/` specifier from inflect's src/ is spelled inside the package, or null if it may not be. */
export function rewriteAppAlias(specifier) {
  for (const prefix of ['@/components/ui/', '@/lib/hooks/']) {
    if (specifier.startsWith(prefix)) return `@inflect/ui/${specifier.slice(2)}`;
  }
  return null;
}

/**
 * Every module specifier in a source file, with the span of its text. TypeScript
 * reports `pos` at the opening quote, so the specifier itself starts one later.
 */
export function importsOf(source) {
  const info = ts.preProcessFile(source, true, true);
  return info.importedFiles.map((f) => {
    const pos = f.pos + 1;
    const end = pos + f.fileName.length;
    if (source.slice(pos, end) !== f.fileName) throw new SyncError(`Could not locate import ${f.fileName}`);
    return { specifier: f.fileName, pos, end };
  });
}

/**
 * Every whitespace-separated word inside a string or template literal, with
 * any Tailwind variant prefix (`md:`, `hover:`, `!`) removed. Comments are not
 * strings, so prose that mentions a class does not count as using it.
 */
export function stringWordsOf(source, fileName) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  const words = new Set();
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const word of node.text.split(/\s+/)) {
        const bare = word.slice(word.lastIndexOf(':') + 1).replace(/^!/, '');
        if (bare) words.add(bare);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return words;
}

/** Class names a stylesheet defines at the start of a selector line. */
export function classesDefinedIn(css) {
  const out = new Set();
  for (const match of css.matchAll(/^\s*\.([A-Za-z][\w-]*)/gm)) out.add(match[1]);
  return out;
}

/**
 * Classes the host application's stylesheet defines that vendored code names
 * in a string. The package does not ship these recipes, so every consumer has
 * to define them; the manifest lists them so a test here can insist it does.
 */
function hostClassesReferenced(upstream, files) {
  const hostClasses = classesDefinedIn(upstream.read('src/app/globals.css').toString('utf8'));
  const out = {};
  for (const [destination, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    for (const word of stringWordsOf(file.bytes.toString('utf8'), destination)) {
      if (hostClasses.has(word)) (out[word] ??= []).push(destination);
    }
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

function buildTree(upstream, config, dependencyNames) {
  const rewritesByFile = new Map();
  for (const r of config.importRewrites ?? []) {
    if (!rewritesByFile.has(r.file)) rewritesByFile.set(r.file, new Map());
    rewritesByFile.get(r.file).set(r.from, r.to);
  }

  const queue = config.entries.map((e) => canonical(e, upstream.files));
  const seen = new Set();
  const out = new Map(); // destination -> { source, bytes, sourceSha256, transformed }
  const externals = new Map(); // package -> Set(destination)
  const errors = [];

  while (queue.length > 0) {
    const upstreamPath = queue.shift();
    if (seen.has(upstreamPath)) continue;
    seen.add(upstreamPath);

    const original = upstream.read(upstreamPath);
    const text = original.toString('utf8');
    const fromApp = upstreamPath.startsWith('src/');
    const declared = rewritesByFile.get(upstreamPath) ?? new Map();
    const edits = [];

    for (const { specifier, pos, end } of importsOf(text)) {
      let spec = specifier;
      if (declared.has(spec)) {
        spec = declared.get(spec);
        edits.push({ pos, end, value: spec });
      }
      let target = null;
      if (spec.startsWith('.')) {
        target = resolveCandidate(path.posix.join(path.posix.dirname(upstreamPath), spec), upstream.files);
      } else if (spec === '@inflect/ui') {
        target = resolveCandidate('packages/ui/src/index', upstream.files);
      } else if (spec.startsWith('@inflect/ui/')) {
        target = resolveCandidate(`packages/ui/src/${spec.slice('@inflect/ui/'.length)}`, upstream.files);
      } else if (spec.startsWith('@/')) {
        const rewritten = fromApp ? rewriteAppAlias(spec) : null;
        if (!rewritten) {
          errors.push(`${upstreamPath} imports ${spec}, which is outside the package boundary`);
          continue;
        }
        if (!declared.has(specifier)) edits.push({ pos, end, value: rewritten });
        target = resolveCandidate(`src/${spec.slice(2)}`, upstream.files);
      } else {
        const name = packageNameOf(spec);
        if (!externals.has(name)) externals.set(name, new Set());
        externals.get(name).add(destinationOf(upstreamPath));
        continue;
      }
      if (!target) errors.push(`${upstreamPath} imports ${spec}, which does not resolve upstream`);
      else queue.push(target);
    }

    let bytes = original;
    if (edits.length > 0) {
      let rewritten = text;
      for (const e of [...edits].sort((a, b) => b.pos - a.pos)) {
        rewritten = rewritten.slice(0, e.pos) + e.value + rewritten.slice(e.end);
      }
      bytes = Buffer.from(rewritten, 'utf8');
    }

    const destination = destinationOf(upstreamPath);
    if (out.has(destination)) {
      errors.push(`${upstreamPath} and ${out.get(destination).source} both land on ${destination}`);
      continue;
    }
    out.set(destination, {
      source: upstreamPath,
      bytes,
      sourceSha256: sha256(original),
      transformed: edits.length > 0,
    });
  }

  for (const [name, users] of externals) {
    if (!dependencyNames.has(name)) {
      errors.push(`${name} is imported by ${[...users].sort().join(', ')} but is not a dependency in package.json`);
    }
  }

  for (const [destination, file] of out) {
    const leftover = importsOf(file.bytes.toString('utf8')).filter((i) => i.specifier.startsWith('@/'));
    for (const l of leftover) errors.push(`${destination} still imports ${l.specifier}`);
  }

  if (errors.length > 0) throw new SyncError(`Refused:\n  - ${errors.join('\n  - ')}`);
  return { files: out, externals };
}

function pick(tree, dotted, locale) {
  let node = tree;
  for (const key of dotted.split('.')) {
    if (node === null || typeof node !== 'object' || !(key in node)) {
      throw new SyncError(`messages/${locale}.json has no key ${dotted}`);
    }
    node = node[key];
  }
  return node;
}

function place(tree, dotted, value) {
  const keys = dotted.split('.');
  let node = tree;
  for (const key of keys.slice(0, -1)) node = node[key] ??= {};
  node[keys.at(-1)] = value;
}

function sortKeys(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

const asJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function buildMessages(upstream, config) {
  const files = new Map();
  for (const locale of config.messages.locales) {
    const tree = JSON.parse(upstream.read(`messages/${locale}.json`).toString('utf8'));
    const picked = {};
    for (const key of config.messages.keys) place(picked, key, pick(tree, key, locale));
    files.set(`messages/${locale}.json`, Buffer.from(asJson(sortKeys(picked)), 'utf8'));
  }
  return files;
}

const README = `# Vendored Inflect UI — do not edit

Generated by \`scripts/sync-inflect-ui.mjs\` from rodnapamet/inflect-compliance at
the commit named in \`manifest.json\`. CI fails if any file here differs from the
manifest (\`npm run vendor:check\`), or from what upstream would produce at that
commit (\`node scripts/sync-inflect-ui.mjs --check\`).

To change a component, change it upstream and re-sync. To move the pin, run
\`npm run vendor:sync -- --ref <commit>\` in a pull request of its own.

The code is licensed under BUSL-1.1; see \`LICENSE\`. Imported as
\`@inflect/ui/...\` through the path alias in \`tsconfig.json\`.
`;

export function generate(upstream, config, dependencyNames) {
  const { files, externals } = buildTree(upstream, config, dependencyNames);
  const hostClasses = hostClassesReferenced(upstream, files);
  const all = new Map();
  for (const [destination, file] of files) all.set(destination, { ...file });
  for (const [destination, bytes] of buildMessages(upstream, config)) {
    all.set(destination, { source: 'messages/*.json (keys in config)', bytes, sourceSha256: null, transformed: true });
  }
  const tokens = upstream.read('packages/ui/tokens.contract.css');
  all.set('tokens.contract.css', { source: 'packages/ui/tokens.contract.css', bytes: tokens, sourceSha256: sha256(tokens), transformed: false });
  const license = upstream.read('LICENSE');
  all.set('LICENSE', { source: 'LICENSE', bytes: license, sourceSha256: sha256(license), transformed: false });
  all.set('README.md', { source: null, bytes: Buffer.from(README, 'utf8'), sourceSha256: null, transformed: true });

  const manifest = {
    repository: config.repository,
    inflectCommit: upstream.commit,
    entries: config.entries,
    externals: Object.fromEntries([...externals.keys()].sort().map((k) => [k, [...externals.get(k)].sort()])),
    hostClassesReferenced: hostClasses,
    files: [...all.keys()].sort().map((p) => {
      const f = all.get(p);
      return {
        path: p,
        source: f.source,
        sha256: sha256(f.bytes),
        ...(f.transformed && f.sourceSha256 ? { sourceSha256: f.sourceSha256 } : {}),
        transformed: f.transformed,
      };
    }),
  };
  all.set(MANIFEST_NAME, { bytes: Buffer.from(asJson(manifest), 'utf8') });
  return all;
}

export function listTree(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const dependencyNames = new Set(Object.keys(pkg.dependencies ?? {}));
  const ref = args.ref ?? config.ref;
  if (args.check && args.ref) throw new SyncError('--check verifies the pinned ref; do not pass --ref');

  const upstream = openUpstream({ repository: config.repository, ref, source: args.source });
  let generated;
  try {
    generated = generate(upstream, config, dependencyNames);
  } finally {
    upstream.dispose();
  }

  if (args.check) {
    const onDisk = listTree(VENDOR_DIR);
    const expected = [...generated.keys()].sort();
    const problems = [];
    for (const p of expected) {
      const disk = path.join(VENDOR_DIR, p);
      if (!fs.existsSync(disk)) problems.push(`missing: ${p}`);
      else if (!fs.readFileSync(disk).equals(generated.get(p).bytes)) problems.push(`differs from upstream: ${p}`);
    }
    for (const p of onDisk) if (!generated.has(p)) problems.push(`not produced by upstream: ${p}`);
    if (problems.length > 0) throw new SyncError(`vendor/inflect-ui does not match ${upstream.commit}:\n  - ${problems.join('\n  - ')}`);
    console.log(`vendor/inflect-ui matches ${config.repository} at ${upstream.commit} (${expected.length} files).`);
    return;
  }

  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  for (const [p, { bytes }] of generated) {
    const target = path.join(VENDOR_DIR, p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  if (config.ref !== upstream.commit) {
    config.ref = upstream.commit;
    fs.writeFileSync(CONFIG_PATH, asJson(config));
  }
  console.log(`Vendored ${generated.size} files from ${upstream.commit} into vendor/inflect-ui.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error instanceof SyncError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
