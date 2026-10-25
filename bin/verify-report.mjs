#!/usr/bin/env node
// The verifier as a command. `npm run build:verifier` bundles it into
// dist/verify-report.mjs (with the registry settings of the build's
// environment); this runs that bundle.
import fs from 'node:fs';

const bundle = new URL('../dist/verify-report.mjs', import.meta.url);
if (!fs.existsSync(bundle)) {
  process.stderr.write('dist/verify-report.mjs is missing: run `npm run build:verifier` first.\n');
  process.exit(2);
}
await import(bundle.href);
