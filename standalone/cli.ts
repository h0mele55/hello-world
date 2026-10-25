import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openRegistryView, readDocument, verifyFile, type PdfjsLike } from '@/lib/verify-core';
import { setupFromDeployment, StandaloneSetupSchema, verdictJson, type StandaloneSetup } from './config';

/**
 * verify-report: the verifier as a command, with the same verify-core the
 * browser runs. Prints the verdict as JSON.
 *
 *   verify-report report.pdf
 *   verify-report report.pdf --deployment deployments/sepolia.json --rpc <url> --rpc <url>
 *
 * Without flags it uses the settings baked in by `npm run build:verifier`.
 * Exit status: 0 a verdict was reached, 3 cannot verify right now, 2 usage.
 */

declare const __VERIFIER_SETUP__: StandaloneSetup | null;

function usage(message: string): never {
  process.stderr.write(`${message}\nusage: verify-report <file.pdf> [--deployment <file> --rpc <url> --rpc <url>]\n`);
  process.exit(2);
}

function setupOf(values: { deployment?: string; rpc?: string[] }): StandaloneSetup {
  if (values.deployment || values.rpc) {
    if (!values.deployment || values.rpc?.length !== 2) usage('--deployment and two --rpc endpoints go together');
    try {
      return setupFromDeployment(JSON.parse(fs.readFileSync(values.deployment, 'utf8')), [values.rpc[0], values.rpc[1]]);
    } catch {
      usage(`${values.deployment} is not a readable deployment record, or an --rpc value is not a URL`);
    }
  }
  if (!__VERIFIER_SETUP__) usage('this build carries no registry settings; give --deployment and two --rpc endpoints');
  return StandaloneSetupSchema.parse(__VERIFIER_SETUP__);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { deployment: { type: 'string' }, rpc: { type: 'string', multiple: true } } });
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length !== 1) usage('give exactly one PDF');
  const file = parsed.positionals[0];
  const setup = setupOf(parsed.values);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(file));
  } catch {
    usage(`${file} cannot be read`);
  }
  const verdict = await verifyFile({
    bytes,
    config: setup,
    openView: () => openRegistryView(setup),
    readPdf: (pdf) => readDocument(pdfjs as unknown as PdfjsLike, pdf),
  });
  process.stdout.write(`${verdictJson({ file: path.basename(file), verdict })}\n`);
  process.exit(verdict.kind === 'CANNOT_VERIFY' ? 3 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write(`verify-report failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
});
