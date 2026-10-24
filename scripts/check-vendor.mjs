#!/usr/bin/env node
/**
 * Fails if anything under vendor/inflect-ui differs from its manifest: a file
 * edited by hand, added, or removed. Runs offline and in under a second, so it
 * belongs in every CI run. `node scripts/sync-inflect-ui.mjs --check` is the
 * stronger, slower twin: it re-derives the tree from upstream.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTree, sha256 } from './sync-inflect-ui.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function checkVendor(root = REPO_ROOT) {
  const vendorDir = path.join(root, 'vendor/inflect-ui');
  const problems = [];
  const manifestPath = path.join(vendorDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return [`missing: vendor/inflect-ui/manifest.json`];

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vendor/inflect-ui.config.json'), 'utf8'));
  if (manifest.inflectCommit !== config.ref) {
    problems.push(`config pins ${config.ref} but the vendored tree is from ${manifest.inflectCommit}; run npm run vendor:sync`);
  }
  if (!/^[0-9a-f]{40}$/.test(config.ref)) problems.push(`config ref must be a full commit sha, got ${config.ref}`);

  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const [p, f] of listed) {
    const full = path.join(vendorDir, p);
    if (!fs.existsSync(full)) problems.push(`missing: ${p}`);
    else if (sha256(fs.readFileSync(full)) !== f.sha256) problems.push(`edited: ${p}`);
  }
  for (const p of listTree(vendorDir)) {
    if (p !== 'manifest.json' && !listed.has(p)) problems.push(`not in manifest: ${p}`);
  }
  for (const required of ['LICENSE', 'tokens.contract.css']) {
    if (!listed.has(required)) problems.push(`manifest does not carry ${required}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkVendor();
  if (problems.length > 0) {
    console.error(`vendor/inflect-ui has drifted from its manifest:\n  - ${problems.join('\n  - ')}\n\nVendored code is never edited in place. Change it upstream, then run npm run vendor:sync.`);
    process.exit(1);
  }
  console.log('vendor/inflect-ui matches its manifest.');
}
