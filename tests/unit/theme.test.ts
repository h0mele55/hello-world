import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

function blockAfter(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

const theme = read('src/styles/theme.css');
const light = declarations(blockAfter(theme, ":root,\n[data-theme='light']"));
// Only the radius scale is shared through :root. Every colour and shadow must
// be declared by the dark block itself: one it forgot would silently inherit
// the light value, which this would otherwise not notice.
const SHARED = ['--radius-sm', '--radius', '--radius-lg', '--radius-xl'];
const dark = new Map([
  ...SHARED.filter((t) => light.has(t)).map((t) => [t, light.get(t)!] as [string, string]),
  ...declarations(blockAfter(theme, "[data-theme='dark']")),
]);
const THEMES = { light, dark } as const;

const contract = [...declarations(blockAfter(read('vendor/inflect-ui/tokens.contract.css'), ':root')).keys()];

function referencedVars(text: string): Set<string> {
  return new Set([...text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
}

function vendoredSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(ROOT, 'vendor/inflect-ui/src'));
  return out;
}

describe('theme tokens', () => {
  it('reads the 47-token contract', () => {
    expect(contract).toHaveLength(47);
  });

  for (const [name, tokens] of Object.entries(THEMES)) {
    it(`${name}: overrides every contract token`, () => {
      expect(contract.filter((t) => !tokens.has(t))).toEqual([]);
    });

    it(`${name}: defines every token the Tailwind config maps`, () => {
      const require = createRequire(import.meta.url);
      const config = JSON.stringify(require(path.join(ROOT, 'tailwind.config.js')).theme);
      const missing = [...referencedVars(config)].filter((v) => !v.startsWith('--radix-') && !tokens.has(v));
      expect(missing).toEqual([]);
    });

    it(`${name}: defines every token the vendored code reads`, () => {
      const sources = vendoredSources().join('\n');
      // Variables a component declares for itself (e.g. --sheet-width) are its own business.
      const local = new Set([...sources.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
      const missing = [...referencedVars(sources)].filter(
        (v) => !v.startsWith('--radix-') && !local.has(v) && !tokens.has(v),
      );
      expect(missing).toEqual([]);
    });

    it(`${name}: gives the shadow-typed tokens shadow values`, () => {
      // The vendored Button and Input use these inside shadow-[...]. A colour
      // here (as the contract's own fallbacks have) is an invalid box-shadow,
      // which silently removes the button lift and the input focus ring.
      for (const t of ['--btn-still-lift', '--btn-still-press', '--ctrl-edge-focus']) {
        expect(tokens.get(t), t).toMatch(/\d+px/);
      }
    });
  }
});

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme contrast (WCAG 2.2 AA)', () => {
  const TEXT = ['default', 'emphasis', 'muted', 'subtle', 'brand', 'success', 'warning', 'error', 'info'].map(
    (n) => `--content-${n}`,
  );

  for (const [name, tokens] of Object.entries(THEMES)) {
    const hex = (t: string) => {
      const v = tokens.get(t);
      if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} ${t} is not a 6-digit hex colour: ${v}`);
      return v;
    };

    it(`${name}: text tokens reach 4.5:1 on page, card and muted surfaces`, () => {
      for (const text of TEXT) {
        for (const surface of ['--bg-page', '--bg-default', '--bg-muted']) {
          expect(contrast(hex(text), hex(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${name}: primary button label reaches 4.5:1 at rest and on hover`, () => {
      for (const fill of ['--brand-default', '--brand-emphasis', '--brand-muted']) {
        expect(contrast(hex('--content-inverted'), hex(fill)), fill).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: destructive button label (white) reaches 4.5:1`, () => {
      for (const fill of ['--btn-still-danger', '--btn-still-danger-deep', '--btn-still-danger-lift']) {
        expect(contrast('#ffffff', hex(fill)), fill).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: form-control edge reaches 3:1 (WCAG 1.4.11)`, () => {
      expect(contrast(hex('--ctrl-edge-rest'), hex('--bg-default'))).toBeGreaterThanOrEqual(3);
    });
  }
});
