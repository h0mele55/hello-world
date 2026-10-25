import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/auth';
import { PrismaClient } from '@/generated/prisma/client';
import { verifyAuditChain } from '@/lib/audit';
import { AnchoringError } from '@/lib/anchoring/errors';
import { BitcoinError, type BitcoinTime } from '@/lib/ots/bitcoin';
import { attestationsOf, parseProof, serializeTimestamp, type Proof, type Timestamp } from '@/lib/ots/format';
import { collectAlerts } from '@/lib/monitor';
import { runOtsPass, type OtsJobDeps } from '@/lib/ots/job';
import { getOtsProof, readOtsProof } from '@/lib/ots/queries';
import { confirmOpinion, createEngagement, uploadVersion } from '@/lib/reports/intake';

/**
 * The OpenTimestamps job (#66) against a real database, with fake calendars
 * and a stubbed Bitcoin check (tests/unit/ots.test.ts checks a real proof
 * against a real block): a final version's manifest hash is submitted once,
 * kept only when two calendars took it, upgraded when a calendar has the path
 * to Bitcoin, COMPLETE only on the Bitcoin check and BROKEN only when that
 * check says the proof is wrong.
 */

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'pdf', name));
const ALICE = 'https://alice.example';
const BOB = 'https://bob.example';
const CAROL = 'https://carol.example';
const HEIGHT = 900_000;
const MINUTE = 60_000;

let orgId: string;
let preparer: SessionUser;
let approverId: string;
let clock: Date;

beforeEach(async () => {
  clock = new Date('2026-10-25T09:00:00Z');
  fs.rmSync(process.env.FILE_STORAGE_DIR!, { recursive: true, force: true });
  await prisma.$executeRawUnsafe('TRUNCATE "OtsProof", "ChainWrite", "AuditEvent", "ReportVersion", "StoredFile", "Engagement", "Client", "User", "IssuerOrg" CASCADE');
  orgId = (await prisma.issuerOrg.create({ data: { name: 'Example Audit OOD' } })).id;
  const user = await prisma.user.create({ data: { orgId, email: 'preparer@example.test', name: 'Preparer', role: 'PREPARER', passwordHash: 'x' } });
  preparer = { id: user.id, email: user.email, name: user.name, role: 'PREPARER', orgId, mfa: 'NOT_REQUIRED' };
  approverId = (await prisma.user.create({ data: { orgId, email: 'approver@example.test', name: 'Approver', role: 'APPROVER', passwordHash: 'x' } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

let engagementN = 0;
/** A confirmed version, made final on chain as the worker would leave it when `anchored`. */
async function version(file: string, anchored: boolean) {
  engagementN += 1;
  const engagement = await createEngagement(preparer, { clientName: 'Example Manufacturing AD', registrationNumber: '123456789', country: 'BG', engagementRef: `ENG-OTS-${engagementN}`, periodEnd: '2025-12-31', reportType: 'STANDALONE' });
  const uploaded = await uploadVersion(preparer, { engagementId: engagement.id, reasonCode: 'INITIAL', bytes: fixture(file) });
  await confirmOpinion(preparer, { versionId: uploaded.id, opinionType: 'UNMODIFIED', text: 'In our opinion, the financial statements present fairly.', reportDate: '2026-03-31' });
  if (anchored) {
    await prisma.reportVersion.update({
      where: { id: uploaded.id },
      data: { status: 'ANCHORED', approvedById: approverId, approvedAt: clock, recordId: `0x${engagementN.toString(16).padStart(64, '0')}`, anchorBlock: 100n },
    });
  }
  return prisma.reportVersion.findUniqueOrThrow({ where: { id: uploaded.id }, select: { id: true, manifestHash: true } });
}

/** What a calendar answers at once: pending at itself. */
const pendingAt = (uri: string): Timestamp => ({
  attestations: [],
  ops: [{ op: { op: 'prepend', arg: new Uint8Array([0x5f, 0, 0, 1]) }, next: { attestations: [], ops: [{ op: { op: 'sha256' }, next: { attestations: [{ kind: 'pending', uri }], ops: [] } }] } }],
});
/** What it answers once Bitcoin has its batch: a path to a block. */
const confirmedAnswer: Timestamp = { attestations: [], ops: [{ op: { op: 'append', arg: new Uint8Array([1]) }, next: { attestations: [], ops: [{ op: { op: 'sha256' }, next: { attestations: [{ kind: 'bitcoin', height: HEIGHT }], ops: [] } }] } }] };

type Answer = 'pending' | 'confirmed' | 'down' | 'not-yet';
/** Calendars whose answers the test sets, counting what they are asked. */
function calendars(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const calendar = u.origin;
    asked.push(`${calendar}${u.pathname.startsWith('/digest') ? '/digest' : '/timestamp'}`);
    const answer = answers[calendar];
    if (answer === 'down' || !answer) return new Response('', { status: 503 });
    if (u.pathname === '/digest') return new Response(serializeTimestamp(pendingAt(calendar)));
    if (answer === 'not-yet' || answer === 'pending') return new Response('', { status: 404 });
    return new Response(serializeTimestamp(confirmedAnswer));
  });
  return { deps: { calendars: [ALICE, BOB, CAROL], fetch: fetchImpl as unknown as typeof fetch }, asked };
}

/** The Bitcoin check, stubbed: a proof with a Bitcoin attestation reaches the block, or fails as told. */
function bitcoin(outcome: 'ok' | BitcoinError = 'ok') {
  return async (proof: Proof): Promise<BitcoinTime | null> => {
    if (!attestationsOf(proof).some((a) => a.attestation.kind === 'bitcoin')) return null;
    if (outcome !== 'ok') throw outcome;
    return { height: HEIGHT, blockHash: `0x${'0'.repeat(20)}${'ab'.repeat(22)}`, time: 1_790_000_000 };
  };
}

const pass = (deps: Partial<OtsJobDeps> & Pick<OtsJobDeps, 'calendar'>) => runOtsPass({ prisma, now: () => clock, bitcoinTime: bitcoin(), ...deps });
const events = async () => (await prisma.auditEvent.findMany({ where: { orgId, action: { startsWith: 'ots.' } }, orderBy: { seq: 'asc' } })).map((e) => ({ action: e.action, data: e.data }));

describe('submitting', () => {
  it('sends a final version’s manifest hash once, and keeps the proof once two calendars took it', async () => {
    const final = await version('en-unmodified.pdf', true);
    await version('en-qualified.pdf', false);
    const cal = calendars({ [ALICE]: 'pending', [BOB]: 'pending', [CAROL]: 'down' });

    const report = await pass({ calendar: cal.deps });
    expect(report).toMatchObject({ submitted: [final.id], notSubmitted: [], complete: [], broken: [] });
    const row = await prisma.otsProof.findUniqueOrThrow({ where: { reportVersionId: final.id } });
    expect(row).toMatchObject({ status: 'PENDING', digest: final.manifestHash, calendars: [ALICE, BOB], submittedAt: clock });
    expect(attestationsOf(parseProof(new Uint8Array(row.proof))).map((a) => a.attestation)).toEqual([
      { kind: 'pending', uri: ALICE },
      { kind: 'pending', uri: BOB },
    ]);
    expect(await events()).toEqual([{ action: 'ots.submitted', data: { otsProofId: row.id, manifestHash: final.manifestHash, calendars: 2 } }]);

    // A later pass asks about the proof, and never submits the version again.
    cal.asked.length = 0;
    await pass({ calendar: cal.deps });
    expect(cal.asked.filter((a) => a.endsWith('/digest'))).toEqual([]);
    expect(await prisma.otsProof.count()).toBe(1);
  });

  it('keeps nothing when fewer than two calendars took it, and tries again next pass', async () => {
    const final = await version('en-unmodified.pdf', true);
    const report = await pass({ calendar: calendars({ [ALICE]: 'pending', [BOB]: 'down', [CAROL]: 'down' }).deps });
    expect(report).toMatchObject({ submitted: [], notSubmitted: [final.id] });
    expect(await prisma.otsProof.count()).toBe(0);
    expect(await events()).toEqual([]);
    expect((await pass({ calendar: calendars({ [ALICE]: 'pending', [BOB]: 'pending' }).deps })).submitted).toEqual([final.id]);
  });
});

describe('upgrading and checking', () => {
  it('waits while the calendars have nothing, then completes on the Bitcoin check', async () => {
    const final = await version('en-unmodified.pdf', true);
    const waiting = calendars({ [ALICE]: 'not-yet', [BOB]: 'not-yet' });
    expect(await pass({ calendar: waiting.deps })).toMatchObject({ submitted: [final.id], pending: [] });
    // Not asked about until the interval has passed, then asked, then not again for another interval.
    waiting.asked.length = 0;
    clock = new Date(clock.getTime() + 29 * MINUTE);
    expect((await pass({ calendar: waiting.deps })).pending).toEqual([]);
    expect(waiting.asked).toEqual([]);
    clock = new Date(clock.getTime() + 2 * MINUTE);
    expect((await pass({ calendar: waiting.deps })).pending).toEqual([{ versionId: final.id, reason: null }]);
    expect(waiting.asked).toEqual([`${ALICE}/timestamp`, `${BOB}/timestamp`]);
    waiting.asked.length = 0;
    clock = new Date(clock.getTime() + 10 * MINUTE);
    expect((await pass({ calendar: waiting.deps })).pending).toEqual([]);
    expect(waiting.asked).toEqual([]);

    clock = new Date(clock.getTime() + 30 * MINUTE);
    const report = await pass({ calendar: calendars({ [ALICE]: 'confirmed', [BOB]: 'not-yet' }).deps });
    expect(report.complete).toEqual([final.id]);
    const row = await prisma.otsProof.findUniqueOrThrow({ where: { reportVersionId: final.id } });
    expect(row).toMatchObject({ status: 'COMPLETE', bitcoinHeight: HEIGHT, bitcoinTime: new Date(1_790_000_000_000), completedAt: clock, lastError: null });
    // The stored proof is the upgraded one: it reaches the block on its own.
    expect(attestationsOf(parseProof(new Uint8Array(row.proof))).map((a) => a.attestation)).toContainEqual({ kind: 'bitcoin', height: HEIGHT });
    expect((await events()).map((e) => e.action)).toEqual(['ots.submitted', 'ots.complete']);
    expect((await events())[1].data).toEqual({ otsProofId: row.id, bitcoinHeight: HEIGHT, bitcoinBlockHash: row.bitcoinBlockHash });
    expect(await verifyAuditChain(prisma, orgId)).toMatchObject({ ok: true });

    // A complete proof is not asked about again.
    clock = new Date(clock.getTime() + 60 * MINUTE);
    const after = calendars({ [ALICE]: 'confirmed', [BOB]: 'confirmed' });
    await pass({ calendar: after.deps });
    expect(after.asked).toEqual([]);
  });

  it('stays pending, naming why, when the calendars or the explorers cannot be read', async () => {
    const final = await version('en-unmodified.pdf', true);
    await pass({ calendar: calendars({ [ALICE]: 'pending', [BOB]: 'pending' }).deps });

    clock = new Date(clock.getTime() + 31 * MINUTE);
    expect((await pass({ calendar: calendars({ [ALICE]: 'down', [BOB]: 'down' }).deps })).pending).toEqual([{ versionId: final.id, reason: 'CALENDARS_UNREACHABLE' }]);
    clock = new Date(clock.getTime() + 31 * MINUTE);
    const report = await pass({ calendar: calendars({ [ALICE]: 'confirmed' }).deps, bitcoinTime: bitcoin(new BitcoinError('DISAGREE', 'the explorers give different blocks')) });
    expect(report.pending).toEqual([{ versionId: final.id, reason: 'BITCOIN_DISAGREE' }]);
    const row = await prisma.otsProof.findUniqueOrThrow({ where: { reportVersionId: final.id } });
    expect(row).toMatchObject({ status: 'PENDING', lastError: 'BITCOIN_DISAGREE', bitcoinHeight: null });
    // The upgrade is kept: the next pass checks Bitcoin without the calendar.
    clock = new Date(clock.getTime() + 31 * MINUTE);
    expect((await pass({ calendar: calendars({}).deps })).complete).toEqual([final.id]);
  });

  it('is BROKEN when the proof leads to something the block does not hold', async () => {
    const final = await version('en-unmodified.pdf', true);
    await pass({ calendar: calendars({ [ALICE]: 'pending', [BOB]: 'pending' }).deps });
    clock = new Date(clock.getTime() + 31 * MINUTE);
    const report = await pass({ calendar: calendars({ [ALICE]: 'confirmed' }).deps, bitcoinTime: bitcoin(new BitcoinError('NOT_IN_BLOCK', 'not the root')) });
    expect(report.broken).toEqual([final.id]);
    expect(await prisma.otsProof.findUniqueOrThrow({ where: { reportVersionId: final.id } })).toMatchObject({ status: 'BROKEN', lastError: 'NOT_IN_BLOCK' });
    expect((await events()).map((e) => e.action)).toEqual(['ots.submitted', 'ots.broken']);

    // A broken proof is left for a person: no pass touches it again.
    clock = new Date(clock.getTime() + 60 * MINUTE);
    const later = calendars({ [ALICE]: 'confirmed' });
    expect(await pass({ calendar: later.deps })).toMatchObject({ complete: [], broken: [], pending: [] });
    expect(later.asked).toEqual([]);
  });

  it('refuses rows the database would not hold: one calendar, or COMPLETE without its block', async () => {
    const final = await version('en-unmodified.pdf', true);
    const base = { reportVersionId: final.id, digest: final.manifestHash!, proof: new Uint8Array([1]), submittedAt: clock };
    await expect(prisma.otsProof.create({ data: { ...base, calendars: [ALICE] } })).rejects.toThrow(/OtsProof_two_calendars/);
    await expect(prisma.otsProof.create({ data: { ...base, calendars: [ALICE, BOB], status: 'COMPLETE' } })).rejects.toThrow(/OtsProof_complete_has_block/);
    await expect(prisma.otsProof.create({ data: { ...base, calendars: [ALICE, BOB], status: 'BROKEN' } })).rejects.toThrow(/OtsProof_broken_has_reason/);
    await expect(prisma.otsProof.create({ data: { ...base, calendars: [ALICE, BOB], digest: 'ABC' } })).rejects.toThrow(/OtsProof_digest_shape/);
  });
});

describe('the monitor', () => {
  const HOUR = 60 * MINUTE;
  const otsAlerts = async (hoursLater: number, from: Date) => (await collectAlerts(prisma, new Date(from.getTime() + hoursLater * HOUR))).filter((a) => a.code.startsWith('OTS_'));
  const runbook = 'docs/runbooks/opentimestamps.md';

  it('reports a version a day without a proof, a proof two days without Bitcoin, and a broken proof for a day', async () => {
    const start = clock;
    await version('en-unmodified.pdf', true);
    expect(await otsAlerts(23, start)).toEqual([]);
    expect(await otsAlerts(25, start)).toEqual([{ code: 'OTS_NOT_SUBMITTED', orgId, detail: { count: 1, oldestApprovedAt: start.toISOString(), runbook } }]);

    await pass({ calendar: calendars({ [ALICE]: 'pending', [BOB]: 'pending' }).deps });
    expect(await otsAlerts(47, start)).toEqual([]);
    clock = new Date(start.getTime() + 47 * HOUR);
    await pass({ calendar: calendars({ [ALICE]: 'down', [BOB]: 'down' }).deps });
    expect(await otsAlerts(49, start)).toEqual([{ code: 'OTS_PENDING_LONG', orgId, detail: { count: 1, oldestSubmittedAt: start.toISOString(), reasons: ['CALENDARS_UNREACHABLE'], runbook } }]);

    clock = new Date(start.getTime() + 50 * HOUR);
    await pass({ calendar: calendars({ [ALICE]: 'confirmed' }).deps, bitcoinTime: bitcoin(new BitcoinError('NOT_IN_BLOCK', 'not the root')) });
    const row = await prisma.otsProof.findFirstOrThrow();
    expect(await otsAlerts(51, start)).toEqual([{ code: 'OTS_BROKEN', orgId, detail: { otsProofId: row.id, reportVersionId: row.reportVersionId, reason: 'NOT_IN_BLOCK', at: clock.toISOString(), runbook } }]);
    expect(await otsAlerts(75, start)).toEqual([]);
  });
});

describe('the console', () => {
  it('shows and serves the firm’s own proofs only', async () => {
    const final = await version('en-unmodified.pdf', true);
    expect(await getOtsProof(preparer, final.id)).toBeNull();
    await expect(readOtsProof(preparer, final.id)).rejects.toThrow(AnchoringError);

    await pass({ calendar: calendars({ [ALICE]: 'pending', [BOB]: 'pending' }).deps });
    expect(await getOtsProof(preparer, final.id)).toMatchObject({ status: 'PENDING', calendars: [ALICE, BOB], submittedAt: clock, bitcoinHeight: null });
    const stored = await prisma.otsProof.findUniqueOrThrow({ where: { reportVersionId: final.id } });
    const served = await readOtsProof(preparer, final.id);
    expect(Buffer.from(served.bytes).equals(Buffer.from(stored.proof))).toBe(true);
    expect(served.version).toBe(1);

    const other = await prisma.issuerOrg.create({ data: { name: 'Another Firm' } });
    const outsider: SessionUser = { ...preparer, id: 'outsider', orgId: other.id };
    await expect(getOtsProof(outsider, final.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(readOtsProof(outsider, final.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
