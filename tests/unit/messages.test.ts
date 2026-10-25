import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeMessages } from '@/lib/merge-messages';
import { LOCALES } from '@/lib/preferences';

const ROOT = path.resolve(__dirname, '../..');
const load = (p: string) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

function keyPaths(tree: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' ? keyPaths(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('messages', () => {
  it('merges nested trees', () => {
    expect(mergeMessages({ a: { b: 'x' } }, { a: { c: 'y' }, d: 'z' })).toEqual({ a: { b: 'x', c: 'y' }, d: 'z' });
  });

  it('refuses a key defined on both sides', () => {
    expect(() => mergeMessages({ a: { b: 'x' } }, { a: { b: 'y' } })).toThrow(/a\.b is defined twice/);
  });

  for (const locale of LOCALES) {
    it(`${locale}: the app's messages and the vendored ones do not collide`, () => {
      expect(() => mergeMessages(load(`vendor/inflect-ui/messages/${locale}.json`), load(`messages/${locale}.json`))).not.toThrow();
    });
  }

  it('every locale carries the same keys as English', () => {
    const en = keyPaths(load('messages/en.json')).sort();
    for (const locale of LOCALES) {
      expect(keyPaths(load(`messages/${locale}.json`)).sort(), locale).toEqual(en);
      expect(keyPaths(load(`vendor/inflect-ui/messages/${locale}.json`)).sort(), `vendored ${locale}`).toEqual(
        keyPaths(load('vendor/inflect-ui/messages/en.json')).sort(),
      );
    }
  });
});
