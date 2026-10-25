import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, NonCanonicalValueError, strictCanonicalJson } from '@/lib/canonical-json';
import {
  canonicalFamilyKey,
  CommitmentInputError,
  docHashOf,
  familyIdOf,
  isIsoDate,
  newSalt,
  opinionCommitmentOf,
  type FamilyKey,
} from '@/lib/commitments';
import { buildManifest, canonicalManifest, ManifestError, manifestHashOf, parseManifest, type Manifest } from '@/lib/manifest';

const SECRET = new Uint8Array(32).fill(7);
const SALT = new Uint8Array(32).fill(0x11);
const KEY: FamilyKey = { registrationNumber: '123456789', periodEnd: '2025-12-31', reportType: 'STANDALONE', engagementRef: 'ENG-2026-014' };

describe('canonical JSON', () => {
  it('sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
  });

  it('strict mode refuses values the copied function would silently coerce', () => {
    for (const value of [{ a: undefined }, { a: Number.NaN }, { a: 1.5 }, { a: new Date(0) }, { a: new Map() }, [1, , 3], { a: String.fromCharCode(0xd800) }]) {
      expect(() => strictCanonicalJson(value)).toThrow(NonCanonicalValueError);
    }
  });
});

describe('docHash', () => {
  it('is SHA-256 of the exact bytes, 0x-prefixed lower-case hex', () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 test');
    expect(docHashOf(bytes)).toBe(`0x${createHash('sha256').update(bytes).digest('hex')}`);
    expect(docHashOf(bytes)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('familyId', () => {
  it('is HMAC-SHA256 over the versioned canonical family key', () => {
    const preimage = '{"engagementRef":"ENG-2026-014","periodEnd":"2025-12-31","registrationNumber":"123456789","reportType":"STANDALONE","v":1}';
    expect(familyIdOf(SECRET, KEY)).toBe(`0x${createHmac('sha256', SECRET).update(preimage).digest('hex')}`);
  });

  it('ignores spacing and case that do not change which report it is', () => {
    expect(familyIdOf(SECRET, { ...KEY, registrationNumber: ' 1234 56789 ', engagementRef: '  ENG-2026-014 ' })).toBe(familyIdOf(SECRET, KEY));
    expect(canonicalFamilyKey({ ...KEY, registrationNumber: 'bg123' }).registrationNumber).toBe('BG123');
  });

  it('separates standalone from consolidated, and one engagement from another (#6)', () => {
    const ids = new Set([
      familyIdOf(SECRET, KEY),
      familyIdOf(SECRET, { ...KEY, reportType: 'CONSOLIDATED' }),
      familyIdOf(SECRET, { ...KEY, engagementRef: 'ENG-2026-015' }),
      familyIdOf(SECRET, { ...KEY, periodEnd: '2024-12-31' }),
      familyIdOf(new Uint8Array(32).fill(8), KEY),
    ]);
    expect(ids.size).toBe(5);
  });

  it('refuses a short secret and keys it cannot make canonical', () => {
    expect(() => familyIdOf(new Uint8Array(31), KEY)).toThrow(CommitmentInputError);
    for (const bad of [
      { ...KEY, registrationNumber: '' },
      { ...KEY, registrationNumber: '123/456' },
      { ...KEY, periodEnd: '2025-02-30' },
      { ...KEY, periodEnd: '31.12.2025' },
      { ...KEY, reportType: 'ANNUAL' as FamilyKey['reportType'] },
      { ...KEY, engagementRef: '   ' },
      { ...KEY, engagementRef: 'x'.repeat(65) },
    ]) {
      expect(() => familyIdOf(SECRET, bad)).toThrow(CommitmentInputError);
    }
  });

  it('isIsoDate accepts only real calendar dates', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(isIsoDate('2025-13-01')).toBe(false);
  });
});

describe('opinion commitment', () => {
  const text = 'In our opinion, the financial statements present fairly, in all material respects.';

  it('is SHA-256(salt || type || 0x1F || text)', () => {
    const expected = createHash('sha256').update(SALT).update('QUALIFIED').update(Buffer.from([0x1f])).update(text).digest('hex');
    expect(opinionCommitmentOf({ salt: SALT, type: 'QUALIFIED', text })).toBe(`0x${expected}`);
  });

  it('changes with the type, the text or the salt', () => {
    const base = opinionCommitmentOf({ salt: SALT, type: 'UNMODIFIED', text });
    expect(opinionCommitmentOf({ salt: SALT, type: 'QUALIFIED', text })).not.toBe(base);
    expect(opinionCommitmentOf({ salt: SALT, type: 'UNMODIFIED', text: text.replace('fairly', 'unfairly') })).not.toBe(base);
    expect(opinionCommitmentOf({ salt: newSalt(), type: 'UNMODIFIED', text })).not.toBe(base);
  });

  it('refuses text that is not normalised, so nothing hidden changes what is committed', () => {
    expect(() => opinionCommitmentOf({ salt: SALT, type: 'UNMODIFIED', text: `${text}  ` })).toThrow(CommitmentInputError);
    expect(() => opinionCommitmentOf({ salt: SALT, type: 'UNMODIFIED', text: 'a' + String.fromCharCode(0xad) + 'b' })).toThrow(CommitmentInputError);
    expect(() => opinionCommitmentOf({ salt: SALT, type: 'UNMODIFIED', text: 'a' + String.fromCharCode(0xd800) })).toThrow(CommitmentInputError);
    expect(() => opinionCommitmentOf({ salt: SALT, type: 'UNMODIFIED', text: '' })).toThrow(CommitmentInputError);
  });

  it('refuses a salt of the wrong length and an unknown type', () => {
    expect(() => opinionCommitmentOf({ salt: new Uint8Array(16), type: 'UNMODIFIED', text })).toThrow(CommitmentInputError);
    expect(() => opinionCommitmentOf({ salt: SALT, type: 'CLEAN' as 'UNMODIFIED', text })).toThrow(CommitmentInputError);
  });

  it('newSalt is 32 fresh bytes each time', () => {
    const a = newSalt();
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(newSalt()))).toBe(false);
  });
});

describe('manifest v1', () => {
  const h = (byte: string) => `0x${byte.repeat(64)}` as const;
  const fields: Omit<Manifest, 'schema' | 'norm'> = {
    familyId: h('a'),
    version: 1,
    reasonCode: 'INITIAL',
    docHash: h('b'),
    pageCount: 4,
    reportDate: '2026-03-20',
    opinionType: 'UNMODIFIED',
    opinionCommitment: h('c'),
    manifestSalt: h('d'),
  };

  it('hashes its canonical JSON', () => {
    const manifest = buildManifest(fields);
    const json = canonicalManifest(manifest);
    expect(json.startsWith('{"docHash":')).toBe(true);
    expect(manifestHashOf(manifest)).toBe(`0x${createHash('sha256').update(json).digest('hex')}`);
  });

  it('refuses unknown schema and normaliser versions before anything else', () => {
    const manifest = buildManifest(fields);
    expect(() => parseManifest({ ...manifest, schema: 2 })).toThrow(expect.objectContaining({ code: 'UNKNOWN_SCHEMA_VERSION' }));
    expect(() => parseManifest({ ...manifest, norm: 2 })).toThrow(expect.objectContaining({ code: 'UNKNOWN_NORMALISER_VERSION' }));
    expect(() => parseManifest([manifest])).toThrow(ManifestError);
  });

  it('refuses unknown keys, bad hex, upper-case hex and an INITIAL reissue', () => {
    const manifest = buildManifest(fields);
    for (const bad of [
      { ...manifest, extra: 1 },
      { ...manifest, docHash: '0x1234' },
      { ...manifest, docHash: `0x${'B'.repeat(64)}` },
      { ...manifest, version: 2 },
      { ...manifest, reasonCode: 'CORRECTION' },
      { ...manifest, reportDate: '2026-02-30' },
      { ...manifest, pageCount: 0 },
    ]) {
      expect(() => parseManifest(bad)).toThrow(expect.objectContaining({ code: 'INVALID' }));
    }
    expect(() => buildManifest({ ...fields, version: 2, reasonCode: 'CORRECTION' })).not.toThrow();
  });
});
