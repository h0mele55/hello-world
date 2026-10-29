/**
 * Makes the published single-file verifier's site and release notes (#85)
 * from what `npm run build:verifier` wrote (standalone/site.ts):
 *
 *   npx tsx scripts/verifier-site.ts --out <dir> --notes <file> [--repo owner/name] [--commit <sha>]
 *
 * --repo defaults to GITHUB_REPOSITORY and --commit to GITHUB_SHA, then to
 * the checked-out commit. It prints the release's tag, SHA-256 and URL as
 * JSON and, under GitHub Actions, sets them as step outputs.
 * .github/workflows/verifier-pages.yml runs it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verifierSite, VerifierSiteError } from '../standalone/site';

const ROOT = path.resolve(import.meta.dirname, '..');

function refuse(message: string): never {
  console.error(`verifier-site: ${message}`);
  process.exit(1);
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function main() {
  const out = option('out');
  const notesFile = option('notes');
  if (!out || !notesFile) refuse('usage: --out <dir> --notes <file> [--repo owner/name] [--commit <sha>]');
  const repo = option('repo') ?? process.env.GITHUB_REPOSITORY ?? refuse('give --repo owner/name, or run under GitHub Actions');
  const commit = option('commit') ?? process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

  let html: Uint8Array;
  let built: unknown;
  try {
    html = fs.readFileSync(path.join(ROOT, 'dist', 'verifier.html'));
    built = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'verifier.json'), 'utf8'));
  } catch {
    refuse('dist/verifier.html and dist/verifier.json are needed: run npm run build:verifier first');
  }

  let site;
  try {
    site = verifierSite({ html, built, repo, commit });
  } catch (error) {
    if (error instanceof VerifierSiteError) refuse(error.message);
    throw error;
  }
  fs.mkdirSync(out, { recursive: true });
  for (const [name, bytes] of Object.entries(site.files)) fs.writeFileSync(path.join(out, name), bytes);
  fs.writeFileSync(notesFile, site.notes);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${site.tag}\nsha256=${site.sha256}\nrelease_url=${site.releaseUrl}\n`);
  }
  console.log(JSON.stringify({ tag: site.tag, sha256: site.sha256, releaseUrl: site.releaseUrl, files: Object.keys(site.files) }));
}

main();
