import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifierSite, VerifierSiteError, type BuiltVerifier } from '../../standalone/site';

const HTML = new TextEncoder().encode('<!doctype html><title>Verify an audit report</title><p>stand-in for dist/verifier.html</p>\n');
const SHA256 = createHash('sha256').update(HTML).digest('hex');
const COMMIT = 'a'.repeat(40);
const BUILT: BuiltVerifier = {
  sha256: SHA256,
  network: 'sepolia',
  chainId: 11155111,
  registry: '0x87Ba96d1d48e280429A8ead1059334C34507c31F',
  connectsTo: ['https://rpc.one.example', 'https://rpc.two.example'],
  appUrl: null,
  sealRoots: 0,
  reanchorArchives: 0,
};
const site = (built: unknown = BUILT, overrides: Partial<{ html: Uint8Array; repo: string; commit: string }> = {}) =>
  verifierSite({ html: HTML, built, repo: 'firm/audit-anchor', commit: COMMIT, ...overrides });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('the published single-file verifier (#85)', () => {
  it('publishes the file byte for byte, with its SHA-256 as sha256sum writes it, under a release named by the hash', () => {
    const result = site();
    expect(Object.keys(result.files).sort()).toEqual(['index.html', 'verifier.html', 'verifier.html.sha256']);
    expect(Buffer.from(result.files['verifier.html']).equals(Buffer.from(HTML))).toBe(true);
    expect(text(result.files['verifier.html.sha256'])).toBe(`${SHA256}  verifier.html\n`);
    expect(result.sha256).toBe(SHA256);
    expect(result.tag).toBe(`verifier-sepolia-${SHA256.slice(0, 12)}`);
    expect(result.releaseUrl).toBe(`https://github.com/firm/audit-anchor/releases/tag/${result.tag}`);
  });

  it('is the same for the same build, and names a new release only for a new file', () => {
    const [a, b] = [site(), site(BUILT, { commit: 'b'.repeat(40) })];
    expect(a.tag).toBe(b.tag);
    expect(text(site().files['index.html'])).toBe(text(a.files['index.html']));
    const other = new TextEncoder().encode('<!doctype html><p>another build</p>\n');
    const otherHash = createHash('sha256').update(other).digest('hex');
    expect(site({ ...BUILT, sha256: otherHash }, { html: other }).tag).toBe(`verifier-sepolia-${otherHash.slice(0, 12)}`);
  });

  it('says in both languages what the file reads, its hash, where to download it and how to check a kept copy', () => {
    const index = text(site().files['index.html']);
    for (const expected of [
      SHA256,
      'href="verifier.html"',
      `https://github.com/firm/audit-anchor/releases/download/verifier-sepolia-${SHA256.slice(0, 12)}/verifier.html`,
      `https://github.com/firm/audit-anchor/releases/tag/verifier-sepolia-${SHA256.slice(0, 12)}`,
      `https://github.com/firm/audit-anchor/commit/${COMMIT}`,
      'https://sepolia.etherscan.io/address/0x87Ba96d1d48e280429A8ead1059334C34507c31F',
      'Ethereum Sepolia (chain id 11155111)',
      '<code>https://rpc.one.example</code>, <code>https://rpc.two.example</code>',
      'shasum -a 256 verifier.html',
      'Get-FileHash verifier.html',
      '<section lang="en">',
      '<section lang="bg">',
      'Пазете собствено копие',
      'never uploaded',
    ]) {
      expect(index, expected).toContain(expected);
    }
    expect(index).not.toMatch(/authentic|genuine|автентичн|истинск/i);
  });

  it('runs no script, and its CSP allows its one style and nothing else', () => {
    const index = text(site().files['index.html']);
    expect(index).not.toMatch(/<script|\son[a-z]+=|javascript:/i);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(index)?.[1];
    const style = /<style>([\s\S]*?)<\/style>/.exec(index)?.[1];
    expect(csp).toBeDefined();
    expect(style).toBeDefined();
    const styleHash = createHash('sha256').update(style!, 'utf8').digest('base64');
    expect(csp).toBe(`default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'`);
  });

  it('calls a testnet record prototype evidence, and says nothing of the kind for the production chain', () => {
    const notice = 'prototype evidence, not a legally binding record';
    expect(text(site().files['index.html'])).toContain(notice);
    expect(site().notes).toContain(notice);
    const arbitrum = site({ ...BUILT, network: 'arbitrum', chainId: 42161 });
    expect(text(arbitrum.files['index.html'])).not.toContain(notice);
    expect(arbitrum.notes).not.toContain(notice);
    expect(text(arbitrum.files['index.html'])).toContain('Arbitrum One (chain id 42161)');
  });

  it('writes release notes with the hash, the registry and every origin the file connects to', () => {
    const { notes } = site({ ...BUILT, appUrl: 'https://anchor.example', connectsTo: [...BUILT.connectsTo, 'https://anchor.example'], sealRoots: 2, reanchorArchives: 1 });
    expect(notes).toContain(`    ${SHA256}`);
    expect(notes).toContain(`built from ${COMMIT}`);
    expect(notes).toContain('`0x87Ba96d1d48e280429A8ead1059334C34507c31F` (https://sepolia.etherscan.io/address/0x87Ba96d1d48e280429A8ead1059334C34507c31F)');
    expect(notes).toContain('`https://rpc.one.example`, `https://rpc.two.example`, `https://anchor.example`');
    expect(notes).toContain('Electronic-seal roots: 2; re-anchor archives: 1');
    expect(notes).toContain('sha256sum -c verifier.html.sha256');
  });

  it('writes what the build recorded as text, never as markup', () => {
    const index = text(site({ ...BUILT, connectsTo: ['https://rpc.one.example/"><img src=x>', 'https://rpc.two.example'] }).files['index.html']);
    expect(index).not.toContain('<img');
    expect(index).toContain('&quot;&gt;&lt;img src=x&gt;');
  });

  it('refuses, by name, a record of another build, an unknown network, or a release it could not name', () => {
    expect(() => site({ ...BUILT, sha256: 'f'.repeat(64) })).toThrow(/another file than dist\/verifier\.html/);
    expect(() => site({ ...BUILT, network: 'polygon' })).toThrow(VerifierSiteError);
    expect(() => site({ ...BUILT, connectsTo: [] })).toThrow(VerifierSiteError);
    expect(() => site({ ...BUILT, extra: true })).toThrow(VerifierSiteError);
    expect(() => site(null)).toThrow(VerifierSiteError);
    expect(() => site(BUILT, { repo: 'firm' })).toThrow(/owner\/name/);
    expect(() => site(BUILT, { repo: 'firm/audit anchor' })).toThrow(/owner\/name/);
    expect(() => site(BUILT, { commit: 'abc123' })).toThrow(/full commit hash/);
  });
});
