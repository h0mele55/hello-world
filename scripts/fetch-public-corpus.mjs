/**
 * Downloads the public audit reports listed in tests/fixtures/public-corpus.json
 * into .cache/public-corpus/ (git-ignored), checking each against its expected
 * SHA-256. Real reports are never committed; only their URL and hash are.
 *
 *   node scripts/fetch-public-corpus.mjs
 *
 * A file whose hash differs is deleted and reported: the publisher changed it,
 * and the list must be updated by a person who has looked at the new file.
 * Then measure the opinion locator against the corpus with
 * `npx tsx scripts/measure-opinion-locator.ts`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIST = path.join(ROOT, 'tests', 'fixtures', 'public-corpus.json');
const CACHE = path.join(ROOT, '.cache', 'public-corpus');
const MAX_BYTES = 25 * 1024 * 1024;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Some publishers' CDNs refuse a bare client; a full browser user agent is
// enough (no cookies or JavaScript are needed for any listed file).
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error(`declares ${declared} bytes, over the 25 MB limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`${bytes.length} bytes, over the 25 MB limit`);
  return bytes;
}

async function main() {
  const entries = JSON.parse(fs.readFileSync(LIST, 'utf8')).reports;
  fs.mkdirSync(CACHE, { recursive: true });
  let failed = 0;
  for (const entry of entries) {
    const target = path.join(CACHE, `${entry.id}.pdf`);
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === entry.sha256) {
      console.log(`cached   ${entry.id}`);
      continue;
    }
    try {
      const bytes = await download(entry.url);
      const actual = sha256(bytes);
      if (actual !== entry.sha256) throw new Error(`sha256 ${actual}, expected ${entry.sha256}`);
      fs.writeFileSync(target, bytes);
      console.log(`fetched  ${entry.id} (${bytes.length} bytes)`);
    } catch (error) {
      fs.rmSync(target, { force: true });
      console.error(`FAILED   ${entry.id}: ${error.message}`);
      failed++;
    }
  }
  console.log(`${entries.length - failed} of ${entries.length} reports in ${path.relative(ROOT, CACHE)}`);
  if (failed > 0) process.exitCode = 1;
}

main();
