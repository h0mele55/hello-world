/**
 * Copies pdf.js's worker into public/, so the browser viewer loads it from
 * this origin at /pdf.worker.min.mjs. Runs after every install; the copy is
 * git-ignored and always matches the installed pdfjs-dist.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const source = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
const target = path.resolve(import.meta.dirname, '..', 'public', 'pdf.worker.min.mjs');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
