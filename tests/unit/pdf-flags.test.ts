import { describe, expect, it } from 'vitest';
import { scanRawFlags } from '@/lib/pdf/parse';

const scan = (text: string) => scanRawFlags(Buffer.from(text, 'latin1'));

describe('scanRawFlags', () => {
  it('finds signature, JavaScript, embedded-file and XFA names', () => {
    expect(scan('<< /Type /Sig /ByteRange [0 1 2 3] >>')).toEqual({ signed: true, javascript: false, embeddedFiles: false, xfa: false, editProtected: false });
    expect(scan('<< /S /JavaScript /JS (x) >>').javascript).toBe(true);
    expect(scan('<< /AA << /O << /JS 7 0 R >> >> >>').javascript).toBe(true);
    expect(scan('<< /Names << /EmbeddedFiles 9 0 R >> >>').embeddedFiles).toBe(true);
    expect(scan('<< /AcroForm << /XFA 12 0 R >> >>').xfa).toBe(true);
    expect(scan('trailer << /Encrypt 5 0 R >>').editProtected).toBe(true);
  });

  it('decodes #xx escapes in names, which hide them from a plain search', () => {
    expect(scan('<< /S /Java#53cript >>').javascript).toBe(true);
    expect(scan('<< /#42yteRange [0 0 0 0] >>').signed).toBe(true);
  });

  it('does not match a longer name or plain text', () => {
    expect(scan('<< /JSON (x) /ByteRanges [] >> (JavaScript ByteRange)')).toEqual({ signed: false, javascript: false, embeddedFiles: false, xfa: false, editProtected: false });
  });
});
