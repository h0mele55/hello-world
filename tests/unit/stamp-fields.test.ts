import { describe, expect, it } from 'vitest';
import { infoKeyOf, readStamp, STAMP_NAMESPACE, stampValues, type StampFields } from '@/lib/stamp-fields';

const FIELDS: StampFields = {
  stamp: 1,
  chainId: 11155111,
  contract: '0x87Ba96d1d48e280429A8ead1059334C34507c31F',
  recordId: `0x${'1a'.repeat(32)}`,
  txHash: `0x${'2b'.repeat(32)}`,
  blockNumber: 9876543,
  familyId: `0x${'3c'.repeat(32)}`,
  version: 2,
  verifyUrl: 'https://anchor.example/verify',
  opinionType: 'QUALIFIED',
  opinionSalt: `0x${'4d'.repeat(32)}`,
  norm: 1,
};

const xmpOf = (fields: Record<string, string | number>, prefix = 'auditanchor') =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:${prefix}="${STAMP_NAMESPACE}">` +
  Object.entries(fields).map(([k, v]) => `<${prefix}:${k}>${v}</${prefix}:${k}>`).join('') +
  `</rdf:Description></rdf:RDF></x:xmpmeta>`;
const infoOf = (fields: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [`Custom:${infoKeyOf(k as keyof StampFields)}`, String(v)]));

describe('reading a stamp', () => {
  it('finds nothing in a file that was never stamped', () => {
    expect(readStamp(null, {})).toEqual({ status: 'NONE' });
    expect(readStamp('<x:xmpmeta/>', { Title: 'Report' })).toEqual({ status: 'NONE' });
  });

  it('reads the same fields from XMP and Info', () => {
    expect(readStamp(xmpOf(FIELDS), infoOf(FIELDS))).toEqual({ status: 'FOUND', fields: FIELDS, inXmp: true, inInfo: true });
  });

  it('reads either source alone, as a tool that drops one would leave it', () => {
    expect(readStamp(xmpOf(FIELDS), {})).toMatchObject({ status: 'FOUND', inXmp: true, inInfo: false });
    expect(readStamp(null, infoOf(FIELDS))).toMatchObject({ status: 'FOUND', inXmp: false, inInfo: true });
  });

  it('follows whatever prefix the packet binds to the namespace, and attribute form', () => {
    expect(readStamp(xmpOf(FIELDS, 'aa'), {})).toMatchObject({ status: 'FOUND', fields: FIELDS });
    const attrs = Object.entries(FIELDS).map(([k, v]) => `z:${k}="${v}"`).join(' ');
    expect(readStamp(`<rdf:Description rdf:about="" xmlns:z="${STAMP_NAMESPACE}" ${attrs}/>`, {})).toMatchObject({ status: 'FOUND', fields: FIELDS });
  });

  it('refuses a stamp whose sources disagree or whose values are not well formed', () => {
    expect(readStamp(xmpOf(FIELDS), infoOf({ ...FIELDS, recordId: `0x${'ff'.repeat(32)}` }))).toEqual({ status: 'MALFORMED', reason: 'XMP_INFO_DISAGREE' });
    expect(readStamp(xmpOf({ ...FIELDS, contract: FIELDS.contract.toLowerCase() }), {})).toEqual({ status: 'MALFORMED', reason: 'XMP_INVALID' });
    expect(readStamp(xmpOf({ ...FIELDS, stamp: 2 }), {})).toEqual({ status: 'MALFORMED', reason: 'XMP_INVALID' });
    const partial: Record<string, string | number> = { ...FIELDS };
    delete partial.txHash;
    expect(readStamp(null, infoOf(partial))).toEqual({ status: 'MALFORMED', reason: 'INFO_INVALID' });
  });

  it('writes every field in one order, and refuses a verify URL a PDF string would have to escape', () => {
    expect(stampValues(FIELDS).map(([name]) => name)).toEqual(Object.keys(FIELDS));
    expect(() => stampValues({ ...FIELDS, verifyUrl: 'https://anchor.example/verify?a=(1)' })).toThrow();
    expect(() => stampValues({ ...FIELDS, verifyUrl: 'javascript:alert(1)' })).toThrow();
  });
});
