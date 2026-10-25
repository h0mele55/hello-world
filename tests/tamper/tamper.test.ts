import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgIdFor } from '@/lib/chain/deploy';
import { stampPdf } from '@/lib/stamp';
import { openRegistryView, verifyFile, type Verdict, type VerdictKind, type VerifierConfig } from '@/lib/verify-core';
import { startAnvil, type AnvilHandle } from '../integration/anvil';
import { anchorCopy, anchorOriginal, deployOn, finalise, ISSUER_ORG, readPdf, stampFor, type Anchored, type Registry } from '../integration/registry-harness';
import * as make from './cases';

/**
 * The Phase 4 exit gate: every way of tampering with a COMPLETE version gets
 * the verdict that says exactly what it proves, from the browser's
 * verify-core and from the CLI alike (#48, #49). Needs Foundry (anvil), qpdf
 * and Playwright's Chromium.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'pdf', name)));
const FAMILY = `0x${'c1'.repeat(32)}` as Hex;
const OTHER_FAMILY = `0x${'c2'.repeat(32)}` as Hex;

let anvil: AnvilHandle;
let registry: Registry;
let config: VerifierConfig;
let deploymentFile: string;
let original: Uint8Array;
let copy: Uint8Array;
let anchored: Anchored;
let other: Anchored;
const results: { name: string; expected: string; got: string; cli: string }[] = [];

beforeAll(async () => {
  anvil = await startAnvil();
  registry = await deployOn(anvil.url);
  const { deployment } = registry;
  config = { chainId: deployment.chainId, registry: deployment.address, runtimeBytecodeHash: deployment.runtimeBytecodeHash, rpcUrls: [anvil.url, anvil.url] };

  original = fixture('en-unmodified.pdf');
  anchored = await anchorOriginal(registry, original, FAMILY);
  copy = await stampPdf(original, stampFor(registry, anchored));
  await anchorCopy(registry, anchored, copy);
  other = await anchorOriginal(registry, fixture('en-adverse.pdf'), OTHER_FAMILY);
  await finalise(registry);

  // The CLI as `npm run build:verifier` builds it, pointed at this registry by flags.
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/build-verifier.ts', '--cli-only'], { cwd: ROOT, stdio: 'pipe' });
  deploymentFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-deployment-')), 'deployment.json');
  fs.writeFileSync(
    deploymentFile,
    JSON.stringify({ chainId: deployment.chainId, address: deployment.address, runtimeBytecodeHash: deployment.runtimeBytecodeHash, issuer: { orgId: orgIdFor(ISSUER_ORG), orgName: ISSUER_ORG } }),
  );
}, 120_000);

afterAll(async () => {
  await anvil?.stop();
  if (results.length === 0) return;
  const table = ['| Case | Expected | verify-core | CLI |', '| --- | --- | --- | --- |', ...results.map((r) => `| ${r.name} | ${r.expected} | ${r.got} | ${r.cli} |`)].join('\n');
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'test-results', 'tamper-results.md'), `${table}\n`);
  console.log(`\n${table}\n`);
});

const label = (v: Verdict) => (v.kind === 'NOT_REGISTERED' ? `${v.kind} (${v.note})` : v.kind === 'CANNOT_VERIFY' ? `${v.kind} (${v.reason})` : v.kind);

function runCli(bytes: Uint8Array): Verdict {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-cli-'));
  try {
    const file = path.join(dir, 'report.pdf');
    fs.writeFileSync(file, bytes);
    const run = spawnSync(process.execPath, ['bin/verify-report.mjs', file, '--deployment', deploymentFile, '--rpc', anvil.url, '--rpc', anvil.url], { cwd: ROOT, encoding: 'utf8' });
    if (run.status !== 0 && run.status !== 3) throw new Error(`verify-report exited ${run.status}: ${run.stderr}`);
    return (JSON.parse(run.stdout) as { verdict: Verdict }).verdict;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Verifies a file both ways; both must reach the same verdict, and it must be the expected one. */
async function expectVerdict(name: string, bytes: Uint8Array, expected: VerdictKind, note?: string): Promise<Verdict> {
  const verdict = await verifyFile({ bytes, config, openView: () => openRegistryView(config), readPdf });
  const cli = runCli(bytes);
  results.push({ name, expected: note ? `${expected} (${note})` : expected, got: label(verdict), cli: label(cli) });
  expect(verdict.kind, name).toBe(expected);
  if (note) expect(verdict, name).toMatchObject({ note });
  expect(cli, `${name}: the CLI agrees`).toEqual(verdict);
  return verdict;
}

describe('the tamper suite, from a COMPLETE version', () => {
  it('the untouched original and its stamped copy are AUTHENTIC_LATEST', async () => {
    await expectVerdict('untouched original', original, 'AUTHENTIC_LATEST');
    await expectVerdict('untouched stamped copy', copy, 'AUTHENTIC_LATEST');
  });

  it('a one-byte flip is not the registered file, though its opinion reads the same', async () => {
    await expectVerdict('one-byte flip', make.oneByteFlip(copy), 'ALTERED_OPINION_APPEARS_UNCHANGED');
  });

  it('a metadata-only edit is not the registered file', async () => {
    await expectVerdict('metadata-only edit', await make.metadataOnly(copy), 'ALTERED_OPINION_APPEARS_UNCHANGED');
  });

  it('an edited opinion paragraph is caught', async () => {
    await expectVerdict('edited opinion paragraph', await make.editedOpinion(stampFor(registry, anchored)), 'ALTERED_OPINION_CHANGED');
  });

  it('an opinion type flip is caught', async () => {
    await expectVerdict('opinion type flip (Opinion to Qualified Opinion)', await make.opinionTypeFlip(stampFor(registry, anchored)), 'ALTERED_OPINION_CHANGED');
  });

  it('a re-save by qpdf keeps the reference and the opinion, and is not the registered file', async () => {
    await expectVerdict('re-save with qpdf', make.qpdfResave(copy), 'ALTERED_OPINION_APPEARS_UNCHANGED');
  });

  it('a print to PDF keeps the words and loses the anchor reference', async () => {
    await expectVerdict('print to PDF (Chromium)', await make.printToPdf(copy), 'NOT_REGISTERED', 'NO_REFERENCE');
  });

  it('an appended incremental update is not the registered file', async () => {
    await expectVerdict('appended incremental update', await make.appendedUpdate(copy), 'ALTERED_OPINION_APPEARS_UNCHANGED');
  });

  it('white text hidden in the opinion is read, and caught', async () => {
    await expectVerdict('white hidden-text overlay', await make.hiddenTextOverlay(copy), 'ALTERED_OPINION_CHANGED');
  });

  it('stripping the XMP leaves the Info reference; stripping both leaves none', async () => {
    await expectVerdict('stripped XMP', await make.strippedXmp(copy), 'ALTERED_OPINION_APPEARS_UNCHANGED');
    await expectVerdict('stripped XMP and Info', await make.strippedStamp(copy), 'NOT_REGISTERED', 'NO_REFERENCE');
  });

  it('a forged reference to another record, to no record, or in the XMP alone', async () => {
    const forged = await expectVerdict('stamp forged to name another record', await stampPdf(original, stampFor(registry, other)), 'ALTERED_OPINION_CHANGED');
    expect(forged).toMatchObject({ claimed: { recordId: other.recordId } });
    const nowhere = { ...stampFor(registry, anchored), recordId: `0x${'0d'.repeat(32)}` };
    await expectVerdict('stamp naming no record', await stampPdf(original, nowhere), 'NOT_REGISTERED', 'NAMES_UNKNOWN_RECORD');
    await expectVerdict('XMP alone forged to name another record', await make.forgedXmpOnly(copy, anchored.recordId, other.recordId), 'NOT_REGISTERED', 'REFERENCE_UNREADABLE');
  });

  it('once v2 is anchored, the original and its copy are AUTHENTIC_SUPERSEDED', async () => {
    await anchorOriginal(registry, fixture('en-qualified.pdf'), FAMILY, 2, anchored.recordId);
    await finalise(registry);
    await expectVerdict('untouched original, after v2', original, 'AUTHENTIC_SUPERSEDED');
    await expectVerdict('untouched stamped copy, after v2', copy, 'AUTHENTIC_SUPERSEDED');
  });
});
