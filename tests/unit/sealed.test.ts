import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, open, openJson, seal, SealError, sealJson } from '@/lib/sealed';
import { isThrottled, recordFailure, recordSuccess, resetThrottle } from '@/lib/login-throttle';

const key = { key: new Uint8Array(randomBytes(32)), version: 1 };
const text = new TextEncoder().encode('In our opinion, the financial statements present fairly.');

describe('sealed data (AES-256-GCM)', () => {
  it('round-trips, with a fresh IV each time', () => {
    const a = seal(key, text, 'ctx');
    const b = seal(key, text, 'ctx');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(open([key], a, 'ctx')).equals(Buffer.from(text))).toBe(true);
    expect(openJson([key], sealJson(key, { a: 1 }, 'j'), 'j')).toEqual({ a: 1 });
  });

  it('refuses another context, a changed byte, an unknown key version and the wrong key', () => {
    const sealed = seal(key, text, 'report-version:a:confirmedOpinion');
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as SealError).code;
      }
      return 'opened';
    };
    expect(code(() => open([key], sealed, 'report-version:b:confirmedOpinion'))).toBe('AUTH_FAILED');
    const flipped = new Uint8Array(sealed);
    flipped[flipped.length - 1] ^= 1;
    expect(code(() => open([key], flipped, 'report-version:a:confirmedOpinion'))).toBe('AUTH_FAILED');
    expect(code(() => open([{ ...key, version: 2 }], sealed, 'report-version:a:confirmedOpinion'))).toBe('KEY_VERSION_UNKNOWN');
    expect(code(() => open([{ key: new Uint8Array(randomBytes(32)), version: 1 }], sealed, 'report-version:a:confirmedOpinion'))).toBe('AUTH_FAILED');
    expect(code(() => open([key], sealed.subarray(0, 10), 'x'))).toBe('ENVELOPE_INVALID');
    expect(code(() => seal({ key: new Uint8Array(16), version: 1 }, text, 'x'))).toBe('KEY_INVALID');
  });

  it('encrypt/decrypt keep the parts apart for stored files', () => {
    const parts = encrypt(key, text, 'stored-file:x.bin');
    expect(parts.iv).toHaveLength(12);
    expect(parts.authTag).toHaveLength(16);
    expect(Buffer.from(decrypt(key.key, parts, 'stored-file:x.bin')).equals(Buffer.from(text))).toBe(true);
    expect(() => decrypt(key.key, parts, 'stored-file:y.bin')).toThrow(SealError);
  });
});

describe('login throttle', () => {
  it('refuses an email after five failures, whatever the address, until a success', () => {
    resetThrottle();
    const now = Date.now();
    for (let i = 0; i < 5; i++) recordFailure('Preparer@example.test', `10.0.0.${i}`, now);
    expect(isThrottled('preparer@example.test', '10.9.9.9', now)).toBe(true);
    expect(isThrottled('approver@example.test', null, now)).toBe(false);
    expect(isThrottled('preparer@example.test', null, now + 15 * 60 * 1000 + 1)).toBe(false);
    recordSuccess('preparer@example.test');
    expect(isThrottled('preparer@example.test', null, now)).toBe(false);
  });

  it('refuses an address after twenty failures across emails', () => {
    resetThrottle();
    const now = Date.now();
    for (let i = 0; i < 20; i++) recordFailure(`user${i}@example.test`, '10.0.0.1', now);
    expect(isThrottled('someone-new@example.test', '10.0.0.1', now)).toBe(true);
    expect(isThrottled('someone-new@example.test', null, now)).toBe(false);
  });
});
