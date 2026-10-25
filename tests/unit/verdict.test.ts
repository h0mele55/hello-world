import { bytesToHex, hexToBytes, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { RegistryRecord } from '@/lib/chain/records';
import { normaliseText } from '@/lib/opinion/normalise';
import type { OpinionType } from '@/lib/opinion/types';
import { infoKeyOf, STAMP_NAMESPACE, stampValues, type StampFields } from '@/lib/stamp-fields';
import { docHashOf, opinionCommitmentOf } from '@/lib/verify-core/commitment';
import type { DocumentRead } from '@/lib/verify-core/document';
import { CannotVerify, type RegistryView } from '@/lib/verify-core/registry-view';
import { MAX_FILE_BYTES, verifyFile, type Verdict } from '@/lib/verify-core/verdict';

/**
 * The verdict, decided over a fake registry and a fake PDF reader, so each
 * branch of the decision is pinned without a chain. The Anvil integration
 * test runs the same function over real stamped copies and a real registry.
 */

const CHAIN_ID = 11155111;
const REGISTRY: Address = '0x87Ba96d1d48e280429A8ead1059334C34507c31F';
const ISSUER: Address = '0x00000000000000000000000000000000000000a1';
const ORG = `0x${'0a'.repeat(32)}` as Hex;
const FAMILY = `0x${'f1'.repeat(32)}` as Hex;
const SALT = `0x${'4d'.repeat(32)}` as Hex;
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const bytesOf = (text: string) => new TextEncoder().encode(text);

const OPINION_TEXT = 'In our opinion, the financial statements present fairly, in all material respects, the financial position of the company.';
const reportLines = (heading: string, text: string, basis: string) => [
  ["Independent auditor's report", heading, text, basis, 'We conducted our audit in accordance with ISAs.'],
];
const UNMODIFIED_LINES = reportLines('Opinion', OPINION_TEXT, 'Basis for Opinion');

const commitment = (type: OpinionType, text: string) => opinionCommitmentOf({ salt: hexToBytes(SALT), type, text: normaliseText(text) });

function record(overrides: Partial<RegistryRecord> & Pick<RegistryRecord, 'recordId' | 'docHash'>): RegistryRecord {
  return {
    familyId: FAMILY,
    manifestHash: id(0xe0),
    opinionCommitment: commitment('UNMODIFIED', OPINION_TEXT),
    parentId: id(0),
    issuer: ISSUER,
    blockNumber: 100,
    version: 1,
    kind: 'ORIGINAL',
    revoked: false,
    revokeReason: 0,
    revokeEffectiveAt: 0,
    ...overrides,
  };
}

/** A registry held in memory, answering at block 120. */
function fakeView(records: RegistryRecord[], latest: Record<Hex, Hex> = {}): RegistryView {
  const byId = new Map(records.map((r) => [r.recordId, r]));
  const byDoc = new Map(records.map((r) => [r.docHash, r]));
  return {
    blockNumber: 120n,
    getRecord: async (recordId) => byId.get(recordId) ?? null,
    findByDocHash: async (docHash) => byDoc.get(docHash) ?? null,
    latestOf: async (familyId) => {
      const latestId = latest[familyId];
      return latestId ? (byId.get(latestId) ?? null) : null;
    },
    issuerOrg: async (issuer) => (issuer === ISSUER ? ORG : null),
    blockTime: async (block) => 1_700_000_000 + Number(block) * 12,
    anchoringTx: async (recordId) => (byId.has(recordId) ? (`0x${recordId.slice(4)}aa` as Hex) : null),
  };
}

const STAMP: StampFields = {
  stamp: 1,
  chainId: CHAIN_ID,
  contract: REGISTRY,
  recordId: id(1),
  txHash: `0x${'2b'.repeat(32)}`,
  blockNumber: 100,
  familyId: FAMILY,
  version: 1,
  verifyUrl: 'https://anchor.example/verify',
  opinionType: 'UNMODIFIED',
  opinionSalt: SALT,
  norm: 1,
};

/** What the reader would return for a stamped file: the XMP packet and the mirrored Info keys. */
function stamped(pageLines: string[][], fields: Record<string, string | number> = STAMP): DocumentRead {
  const values = Object.entries(fields);
  const xmp =
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:auditanchor="${STAMP_NAMESPACE}">` +
    values.map(([k, v]) => `<auditanchor:${k}>${v}</auditanchor:${k}>`).join('') +
    `</rdf:Description></rdf:RDF></x:xmpmeta>`;
  const info = Object.fromEntries(values.map(([k, v]) => [`Custom:${infoKeyOf(k as keyof StampFields)}`, String(v)]));
  return { ok: true, doc: { pageLines, xmp, info } };
}

const ORIGINAL_BYTES = bytesOf('%PDF original');
const COPY_BYTES = bytesOf('%PDF original + stamp');
const ORIGINAL = record({ recordId: id(1), docHash: docHashOf(ORIGINAL_BYTES) });
const COPY = record({ recordId: id(2), docHash: docHashOf(COPY_BYTES), kind: 'DISTRIBUTION_COPY', parentId: id(1), blockNumber: 104 });

async function verify(bytes: Uint8Array, view: RegistryView, read?: DocumentRead): Promise<Verdict> {
  return verifyFile({
    bytes,
    config: { chainId: CHAIN_ID, registry: REGISTRY },
    openView: async () => view,
    readPdf: async () => {
      if (!read) throw new Error('the reader should not be needed for an exact match');
      return read;
    },
  });
}

describe('an exact-file match', () => {
  const view = fakeView([ORIGINAL, COPY], { [FAMILY]: id(1) });

  it('is AUTHENTIC_LATEST for the original, and for its distribution copy, without reading the PDF', async () => {
    const original = await verify(ORIGINAL_BYTES, view);
    expect(original).toMatchObject({ kind: 'AUTHENTIC_LATEST', asOfBlock: 120, matched: { recordId: id(1), kind: 'ORIGINAL' }, latest: { recordId: id(1) } });
    const copy = await verify(COPY_BYTES, view);
    expect(copy).toMatchObject({ kind: 'AUTHENTIC_LATEST', matched: { recordId: id(2), kind: 'DISTRIBUTION_COPY' }, original: { recordId: id(1) } });
  });

  it('summarises the record from the chain: block time, anchoring transaction and issuer org', async () => {
    const verdict = await verify(ORIGINAL_BYTES, view);
    if (verdict.kind !== 'AUTHENTIC_LATEST') throw new Error(verdict.kind);
    expect(verdict.matched).toEqual({
      recordId: id(1),
      kind: 'ORIGINAL',
      familyId: FAMILY,
      version: 1,
      docHash: docHashOf(ORIGINAL_BYTES),
      manifestHash: id(0xe0),
      blockNumber: 100,
      blockTime: 1_700_000_000 + 1200,
      txHash: `0x${id(1).slice(4)}aa`,
      issuer: ISSUER,
      orgId: ORG,
      revoked: false,
      revokeReason: 0,
      revokeEffectiveAt: 0,
    });
  });

  it('is AUTHENTIC_SUPERSEDED when a later version is the latest, and names it', async () => {
    const v2 = record({ recordId: id(3), docHash: id(0xd2), version: 2, parentId: id(1), blockNumber: 110 });
    const superseded = fakeView([ORIGINAL, COPY, v2], { [FAMILY]: id(3) });
    for (const bytes of [ORIGINAL_BYTES, COPY_BYTES]) {
      expect(await verify(bytes, superseded)).toMatchObject({ kind: 'AUTHENTIC_SUPERSEDED', original: { version: 1 }, latest: { recordId: id(3), version: 2 } });
    }
  });

  it('is REVOKED when the matched record is revoked, or when a copy\'s original is', async () => {
    const revokedOriginal = { ...ORIGINAL, revoked: true, revokeReason: 2, revokeEffectiveAt: 1_700_000_000 };
    const view1 = fakeView([revokedOriginal, COPY], { [FAMILY]: id(1) });
    expect(await verify(ORIGINAL_BYTES, view1)).toMatchObject({ kind: 'REVOKED', revoked: { recordId: id(1), revokeReason: 2 } });
    expect(await verify(COPY_BYTES, view1)).toMatchObject({ kind: 'REVOKED', matched: { recordId: id(2) }, revoked: { recordId: id(1) } });
    const view2 = fakeView([ORIGINAL, { ...COPY, revoked: true, revokeReason: 1, revokeEffectiveAt: 1_700_000_000 }], { [FAMILY]: id(1) });
    expect(await verify(COPY_BYTES, view2)).toMatchObject({ kind: 'REVOKED', revoked: { recordId: id(2) } });
  });

  it('is REVOCATION_PENDING, never authentic, while a revocation waits out the registry\'s delay', async () => {
    const pending = { revoked: false, revokeReason: 2, revokeEffectiveAt: 1_800_000_000 };
    const pendingOriginal = fakeView([{ ...ORIGINAL, ...pending }, COPY], { [FAMILY]: id(1) });
    expect(await verify(ORIGINAL_BYTES, pendingOriginal)).toMatchObject({
      kind: 'REVOCATION_PENDING',
      matched: { recordId: id(1) },
      pending: { recordId: id(1), revokeReason: 2, revokeEffectiveAt: 1_800_000_000 },
    });
    // A copy whose original is being withdrawn is being withdrawn too.
    expect(await verify(COPY_BYTES, pendingOriginal)).toMatchObject({ kind: 'REVOCATION_PENDING', matched: { recordId: id(2) }, pending: { recordId: id(1) } });
    const pendingCopy = fakeView([ORIGINAL, { ...COPY, ...pending }], { [FAMILY]: id(1) });
    expect(await verify(COPY_BYTES, pendingCopy)).toMatchObject({ kind: 'REVOCATION_PENDING', pending: { recordId: id(2) } });
    // The original itself still stands when only its copy is being withdrawn.
    expect(await verify(ORIGINAL_BYTES, pendingCopy)).toMatchObject({ kind: 'AUTHENTIC_LATEST' });
  });

  it('is REVOKED when one record is revoked and the other only pending', async () => {
    const view = fakeView(
      [{ ...ORIGINAL, revoked: true, revokeReason: 2, revokeEffectiveAt: 1_700_000_000 }, { ...COPY, revoked: false, revokeReason: 1, revokeEffectiveAt: 1_800_000_000 }],
      { [FAMILY]: id(1) },
    );
    expect(await verify(COPY_BYTES, view)).toMatchObject({ kind: 'REVOKED', revoked: { recordId: id(1) } });
  });

  it('refuses a chain that holds a copy without its original, or a family without a latest record', async () => {
    expect(await verify(COPY_BYTES, fakeView([COPY], { [FAMILY]: id(2) }))).toEqual({ kind: 'CANNOT_VERIFY', reason: 'CHAIN_INCONSISTENT' });
    expect(await verify(ORIGINAL_BYTES, fakeView([ORIGINAL, COPY]))).toEqual({ kind: 'CANNOT_VERIFY', reason: 'CHAIN_INCONSISTENT' });
  });
});

describe('a file that is not registered byte for byte', () => {
  const view = fakeView([ORIGINAL, COPY], { [FAMILY]: id(1) });
  const edited = bytesOf('%PDF edited');

  it('is ALTERED_OPINION_APPEARS_UNCHANGED when its opinion recommits to the anchored one, never AUTHENTIC', async () => {
    // Reflowed lines and different spacing normalise to the same text.
    const reflowed = reportLines('Opinion', `In our  opinion, the financial statements present fairly, in all material respects, the financial position of the company.`, 'Basis for Opinion');
    for (const lines of [UNMODIFIED_LINES, reflowed]) {
      const verdict = await verify(edited, view, stamped(lines));
      expect(verdict).toMatchObject({ kind: 'ALTERED_OPINION_APPEARS_UNCHANGED', docHash: docHashOf(edited), claimed: { recordId: id(1) }, original: { recordId: id(1) } });
    }
  });

  it('is ALTERED_OPINION_CHANGED when the opinion type or its words differ', async () => {
    const qualified = reportLines('Qualified Opinion', OPINION_TEXT, 'Basis for Qualified Opinion');
    expect(await verify(edited, view, stamped(qualified))).toMatchObject({ kind: 'ALTERED_OPINION_CHANGED', claimed: { recordId: id(1) } });
    const reworded = reportLines('Opinion', OPINION_TEXT.replace('present fairly', 'do not present fairly'), 'Basis for Opinion');
    expect(await verify(edited, view, stamped(reworded))).toMatchObject({ kind: 'ALTERED_OPINION_CHANGED' });
  });

  it('checks against the original when the stamp names the copy record', async () => {
    const verdict = await verify(edited, view, stamped(UNMODIFIED_LINES, { ...STAMP, recordId: id(2) }));
    expect(verdict).toMatchObject({ kind: 'ALTERED_OPINION_APPEARS_UNCHANGED', claimed: { recordId: id(2) }, original: { recordId: id(1) } });
  });

  it('is ALTERED_OPINION_NOT_CHECKABLE, with the locator\'s reason, when no opinion can be located', async () => {
    const noBasis = [["Independent auditor's report", 'Opinion', OPINION_TEXT]];
    expect(await verify(edited, view, stamped(noBasis))).toMatchObject({ kind: 'ALTERED_OPINION_NOT_CHECKABLE', reason: 'NO_BASIS_HEADING', claimed: { recordId: id(1) } });
    expect(await verify(edited, view, stamped([[]]))).toMatchObject({ kind: 'ALTERED_OPINION_NOT_CHECKABLE', reason: 'NO_TEXT_LAYER' });
  });

  it('reports a revoked original through latest and original, so the page can say so', async () => {
    const revoked = fakeView([{ ...ORIGINAL, revoked: true, revokeReason: 2 }, COPY], { [FAMILY]: id(1) });
    expect(await verify(edited, revoked, stamped(UNMODIFIED_LINES))).toMatchObject({ kind: 'ALTERED_OPINION_APPEARS_UNCHANGED', original: { revoked: true } });
  });

  it('is UNKNOWN_REGISTRY when the stamp names another chain or contract', async () => {
    expect(await verify(edited, view, stamped(UNMODIFIED_LINES, { ...STAMP, chainId: 1 }))).toEqual({
      kind: 'UNKNOWN_REGISTRY',
      docHash: docHashOf(edited),
      asOfBlock: 120,
      claimedChainId: 1,
      claimedContract: REGISTRY,
    });
    const other: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    expect(await verify(edited, view, stamped(UNMODIFIED_LINES, { ...STAMP, contract: other }))).toMatchObject({ kind: 'UNKNOWN_REGISTRY', claimedContract: other });
  });

  it('is NOT_REGISTERED, with a note saying why, for every other file', async () => {
    const note = async (read: DocumentRead) => {
      const verdict = await verify(edited, view, read);
      return verdict.kind === 'NOT_REGISTERED' ? verdict.note : verdict.kind;
    };
    expect(await note({ ok: true, doc: { pageLines: UNMODIFIED_LINES, xmp: null, info: { Title: 'Report' } } })).toBe('NO_REFERENCE');
    expect(await note(stamped(UNMODIFIED_LINES, { ...STAMP, recordId: 'not-a-record' }))).toBe('REFERENCE_UNREADABLE');
    expect(await note(stamped(UNMODIFIED_LINES, { ...STAMP, recordId: id(99) }))).toBe('NAMES_UNKNOWN_RECORD');
    for (const reason of ['UNPARSEABLE', 'ENCRYPTED', 'TOO_MANY_PAGES', 'TOO_MUCH_TEXT', 'TOO_LARGE'] as const) {
      expect(await note({ ok: false, reason })).toBe('PDF_UNREADABLE');
    }
  });

  it('never calls a stamped file with a well-formed but foreign opinion salt authentic', async () => {
    const otherSalt = bytesToHex(new Uint8Array(32).fill(7));
    expect(await verify(edited, view, stamped(UNMODIFIED_LINES, { ...STAMP, opinionSalt: otherSalt }))).toMatchObject({ kind: 'ALTERED_OPINION_CHANGED' });
  });
});

describe('when the chain cannot answer', () => {
  it('is CANNOT_VERIFY with the reason the view gave, and reads no PDF', async () => {
    for (const reason of ['RPC_UNREACHABLE', 'WRONG_CHAIN', 'WRONG_CONTRACT', 'RPC_DISAGREE'] as const) {
      const verdict = await verifyFile({
        bytes: ORIGINAL_BYTES,
        config: { chainId: CHAIN_ID, registry: REGISTRY },
        openView: async () => {
          throw new CannotVerify(reason);
        },
        readPdf: async () => {
          throw new Error('not reached');
        },
      });
      expect(verdict).toEqual({ kind: 'CANNOT_VERIFY', reason });
    }
  });

  it('is CANNOT_VERIFY when a read fails part way, not a verdict built on half an answer', async () => {
    const view = fakeView([ORIGINAL], { [FAMILY]: id(1) });
    const flaky: RegistryView = {
      ...view,
      latestOf: async () => {
        throw new CannotVerify('RPC_DISAGREE');
      },
    };
    expect(await verify(ORIGINAL_BYTES, flaky)).toEqual({ kind: 'CANNOT_VERIFY', reason: 'RPC_DISAGREE' });
  });

  it('refuses a file over the size limit before hashing or reading the chain', async () => {
    const verdict = await verifyFile({
      bytes: new Uint8Array(MAX_FILE_BYTES + 1),
      config: { chainId: CHAIN_ID, registry: REGISTRY },
      openView: async () => {
        throw new Error('not reached');
      },
      readPdf: async () => {
        throw new Error('not reached');
      },
    });
    expect(verdict).toEqual({ kind: 'CANNOT_VERIFY', reason: 'FILE_TOO_LARGE' });
  });

  it('lets an unexpected error through rather than turn it into a verdict', async () => {
    const broken: RegistryView = {
      ...fakeView([ORIGINAL], { [FAMILY]: id(1) }),
      findByDocHash: async () => {
        throw new TypeError('bug');
      },
    };
    await expect(verify(ORIGINAL_BYTES, broken)).rejects.toThrow(TypeError);
  });
});

it('the stamp fixture is one the stamper itself would write', () => {
  expect(() => stampValues(STAMP)).not.toThrow();
});
