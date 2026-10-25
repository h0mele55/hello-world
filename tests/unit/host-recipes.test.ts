import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classesDefinedIn } from '../../scripts/sync-inflect-ui.mjs';

const ROOT = path.resolve(__dirname, '../..');

describe('host recipes', () => {
  it('defines every Inflect host class the vendored code names', () => {
    // The sync records which classes from inflect's own globals.css the
    // vendored files use. The package does not ship those recipes, so this
    // app must; without them a Card renders with no surface on a green build.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/inflect-ui/manifest.json'), 'utf8'));
    const needed = Object.keys(manifest.hostClassesReferenced);
    const defined = classesDefinedIn(fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8'));
    expect(needed.length).toBeGreaterThan(0);
    expect(needed.filter((c) => !defined.has(c))).toEqual([]);
  });
});
