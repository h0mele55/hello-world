import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, open, openJson, seal, SealError, sealJson } from '@/lib/sealed';
import { beginSignIn, isThrottled, MAX_CONCURRENT_SIGN_INS, recordFailure, recordSuccess, resetThrottle, SIGN_INS_PER_MINUTE, takeSignInAttempt, trackedFailureKeys } from '@/lib/login-throttle';

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

  it('locks an address out after ten failures across emails, for fifteen minutes', () => {
    resetThrottle();
    const now = Date.now();
    for (let i = 0; i < 9; i++) recordFailure(`user${i}@example.test`, '10.0.0.1', now);
    expect(isThrottled('someone-new@example.test', '10.0.0.1', now)).toBe(false);
    recordFailure('user9@example.test', '10.0.0.1', now);
    expect(isThrottled('someone-new@example.test', '10.0.0.1', now)).toBe(true);
    expect(isThrottled('someone-new@example.test', null, now)).toBe(false);
    expect(isThrottled('someone-new@example.test', '10.0.0.1', now + 15 * 60 * 1000 + 1)).toBe(false);
  });

  it('lets an address try ten times a minute, right or wrong', () => {
    resetThrottle();
    const now = Date.now();
    for (let i = 0; i < 10; i++) expect(takeSignInAttempt('10.0.0.2', now + i)).toBe(true);
    expect(takeSignInAttempt('10.0.0.2', now + 10)).toBe(false);
    expect(takeSignInAttempt('10.0.0.3', now + 10)).toBe(true);
    expect(takeSignInAttempt(null, now + 10)).toBe(true);
    expect(takeSignInAttempt('10.0.0.2', now + 60_001)).toBe(true);
  });

  it('counts an attempt as a failure from the moment it starts, until it succeeds or is released', () => {
    resetThrottle();
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const attempt = beginSignIn('preparer@example.test', null, now);
      expect(attempt.ok).toBe(true);
      attempt.end('FAILED');
    }
    const fifth = beginSignIn('preparer@example.test', '10.0.0.4', now);
    // Still being checked, and already counted: nothing else gets a guess meanwhile.
    expect(isThrottled('preparer@example.test', null, now)).toBe(true);
    fifth.end('RELEASED');
    expect(isThrottled('preparer@example.test', null, now)).toBe(false);
    expect(isThrottled('other@example.test', '10.0.0.4', now)).toBe(false);
    const sixth = beginSignIn('preparer@example.test', null, now);
    sixth.end('SUCCEEDED');
    sixth.end('FAILED');
    expect(isThrottled('preparer@example.test', null, now)).toBe(false);
    expect(beginSignIn('preparer@example.test', null, now)).toMatchObject({ ok: true });
  });

  it('allows one attempt in flight per email, and refuses a locked one', () => {
    resetThrottle();
    const now = Date.now();
    const first = beginSignIn('Approver@example.test', null, now);
    const second = beginSignIn('approver@example.test', null, now);
    expect(second).toMatchObject({ ok: false, reason: 'IN_FLIGHT' });
    second.end('SUCCEEDED');
    expect(beginSignIn('approver@example.test', null, now)).toMatchObject({ ok: false, reason: 'IN_FLIGHT' });
    first.end('FAILED');
    for (let i = 0; i < 4; i++) beginSignIn('approver@example.test', null, now).end('FAILED');
    expect(beginSignIn('approver@example.test', null, now)).toMatchObject({ ok: false, reason: 'LOCKED' });
  });

  it('holds all sign-ins together to a few at a time and a number a minute, before any password is checked', () => {
    resetThrottle();
    const now = Date.now();
    const open = Array.from({ length: MAX_CONCURRENT_SIGN_INS }, (_, i) => beginSignIn(`user${i}@example.test`, null, now));
    expect(open.every((a) => a.ok)).toBe(true);
    expect(beginSignIn('one-more@example.test', null, now)).toMatchObject({ ok: false, reason: 'BUSY' });
    for (const attempt of open) attempt.end('FAILED');
    for (let i = MAX_CONCURRENT_SIGN_INS; i < SIGN_INS_PER_MINUTE; i++) beginSignIn(`user${i}@example.test`, `10.1.${i}.1`, now).end('FAILED');
    expect(beginSignIn('one-more@example.test', null, now)).toMatchObject({ ok: false, reason: 'BUSY' });
    expect(beginSignIn('one-more@example.test', '10.2.0.1', now + 59_999)).toMatchObject({ ok: false, reason: 'BUSY' });
    expect(beginSignIn('one-more@example.test', null, now + 60_000)).toMatchObject({ ok: true });
  });

  it('forgets expired failures once it tracks many, so random emails cannot grow it without bound', () => {
    resetThrottle();
    const now = Date.now();
    // Five windows of 15,000 new emails each: no more than twice one window's worth is ever kept.
    for (let window = 0; window < 5; window++) {
      for (let i = 0; i < 15_000; i++) recordFailure(`user${window}-${i}@example.test`, null, now + window * 15 * 60 * 1000);
      expect(trackedFailureKeys()).toBeLessThanOrEqual(2 * 15_000 + 1);
    }
  });
});
