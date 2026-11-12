import { describe, expect, it } from 'vitest';
import { normaliseText } from '@/lib/opinion/normalise';
import { readDocument, type PdfjsLike } from '@/lib/verify-core/document';

/**
 * What a hostile PDF can do to the verifiers (#143): its text coordinates
 * and its metadata come from the file, so a reader must refuse what it cannot
 * lay out, by name, rather than freeze or throw.
 */

type Item = { str: string; transform: number[]; width: number; height: number };
const item = (str: string, x: number, y: number): Item => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10 });

/** A stand-in for pdf.js serving one document's pages as given. */
function pdfjsOf(pages: Item[][], options: { metadata?: () => Promise<unknown> } = {}): PdfjsLike {
  const doc = {
    numPages: pages.length,
    getPage: async (n: number) => ({ getTextContent: async () => ({ items: pages[n - 1] }), cleanup: () => {} }),
    getMetadata: (options.metadata ?? (async () => ({ info: {}, metadata: null }))) as () => Promise<{ info: unknown; metadata: unknown }>,
  };
  return { getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} }) };
}
const read = (pdfjs: PdfjsLike) => readDocument(pdfjs, new Uint8Array([1]));

describe('a hostile PDF (#143)', () => {
  it('reads an ordinary page as before', async () => {
    const result = await read(pdfjsOf([[item('Independent auditor’s report', 72, 700), item('Opinion', 72, 680)]]));
    expect(result).toEqual({ ok: true, doc: { pageLines: [['Independent auditor’s report', 'Opinion']], xmp: null, info: {} } });
  });

  it('refuses, by name, text placed a trillion points across the page', async () => {
    expect(await read(pdfjsOf([[item('here', 72, 700), item('there', 1e12, 680)]]))).toEqual({ ok: false, reason: 'UNPARSEABLE' });
    expect(await read(pdfjsOf([[item('nowhere', Number.NaN, 700)]]))).toEqual({ ok: false, reason: 'UNPARSEABLE' });
  });

  it('refuses at once, rather than spends minutes on, lines that swing across fifty million points', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => item(`line ${i}`, i % 2 ? 5e7 : 0, 700 - i * 2));
    const started = performance.now();
    expect(await read(pdfjsOf([lines]))).toEqual({ ok: false, reason: 'UNPARSEABLE' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('reads a page of very many glyphs without overflowing the stack', async () => {
    const glyphs = Array.from({ length: 200_000 }, (_, i) => item('x', 72 + (i % 400), 700 - Math.floor(i / 400)));
    const result = await read(pdfjsOf([glyphs]));
    expect(result.ok || result.reason).not.toBe('UNPARSEABLE');
  });

  it('refuses, by name, metadata pdf.js cannot read', async () => {
    const result = await read(pdfjsOf([[item('text', 72, 700)]], { metadata: async () => Promise.reject(new Error('bad XRef')) }));
    expect(result).toEqual({ ok: false, reason: 'UNPARSEABLE' });
  });
});

describe('normaliser v1 (#143)', () => {
  it('is idempotent where invisible characters sit between a letter and its accent', () => {
    for (const text of ['e​́', 'Мне­́ние', 'cafe⁠́ au lait', 'a﻿̈b', 'x\u0000́']) {
      const once = normaliseText(text);
      expect(normaliseText(once), JSON.stringify(text)).toBe(once);
    }
    expect(normaliseText('e​́')).toBe('é');
  });

  it('is idempotent on any mix of letters, marks, invisibles, controls and spaces', () => {
    const pool = ['a', 'e', 'и', 'Ω', '́', '̈', '​', '­', '⁠', '﻿', '\u0000', '\u0007', ' ', '\t', '\n', 'ﬁ', '①', '\uD800'];
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let n = 0; n < 2_000; n++) {
      const text = Array.from({ length: 1 + (next() % 12) }, () => pool[next() % pool.length]).join('');
      const once = normaliseText(text);
      expect(normaliseText(once), JSON.stringify(text)).toBe(once);
    }
  });
});

describe('the CLI’s endpoints (#143)', () => {
  it('holds two --rpc endpoints to the rule /verify applies', async () => {
    const { rpcUrlsRefusal } = await import('../../standalone/config');
    expect(rpcUrlsRefusal(11155111, ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'])).toBeNull();
    expect(rpcUrlsRefusal(11155111, ['https://sepolia.drpc.org', 'https://sepolia.drpc.org/other'])).toMatch(/different hosts/);
    expect(rpcUrlsRefusal(11155111, ['http://rpc.one.example', 'https://rpc.two.example'])).toMatch(/must be https/);
    expect(rpcUrlsRefusal(11155111, ['https://user:secret@rpc.one.example', 'https://rpc.two.example'])).toMatch(/no credentials/);
    // A local chain is one node twice, over http.
    expect(rpcUrlsRefusal(31337, ['http://127.0.0.1:8545', 'http://127.0.0.1:8545'])).toBeNull();
  });

  it('refuses, by name, a checkpoint whose timestamp is not base64', async () => {
    const { checkReanchorSet } = await import('@/lib/verify-core/reanchor');
    const { CannotVerify } = await import('@/lib/verify-core');
    let thrown: unknown;
    try {
      const h = (c: string) => `0x${c.repeat(64)}`;
      const record = { recordId: h('1'), familyId: h('2'), docHash: h('3'), manifestHash: h('4'), opinionCommitment: h('5'), parentId: h('0'), issuer: `0x${'6'.repeat(40)}`, blockNumber: 1, version: 1, kind: 'ORIGINAL', revoked: false, revokeReason: 0, revokeEffectiveAt: 0, blockTime: 1, txHash: h('7'), orgId: null, familyLatest: h('1') };
      // Base64's own alphabet, and a length no padding makes whole: atob throws on it.
      checkReanchorSet({ format: 'checkpoint/1', source: { chainId: 1, registry: `0x${'8'.repeat(40)}`, block: 1 }, period: '2026-10', root: h('9'), issuers: {}, records: [record], ots: 'abcde' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CannotVerify);
    expect((thrown as Error).message).toMatch(/not base64/);
  });
});
