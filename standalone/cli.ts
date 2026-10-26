import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { bitcoinTimestampFor, CannotVerify, checkReanchorSet, defaultExplorers, issuerProofFetcher, openRegistryView, readDocument, verifyWithReanchors, type CheckedSet, type PdfjsLike } from '@/lib/verify-core';
import { certificatesFromPem, sealStatusFor } from '@/lib/verify-core/seal';
import { rootsOf, setupFromDeployment, StandaloneSetupSchema, verdictJson, type StandaloneSetup } from './config';

/**
 * verify-report: the verifier as a command, with the same verify-core the
 * browser runs. Prints the verdict as JSON.
 *
 *   verify-report report.pdf
 *   verify-report report.pdf --deployment deployments/sepolia.json --rpc <url> --rpc <url> [--app-url <url>] [--seal-roots <pem>]
 *   verify-report report.pdf ... --reanchor archive.json [--reanchor proof.json]
 *
 * Without flags it uses the settings baked in by `npm run build:verifier`.
 * For a file that matches a record, and with the issuer's public origin
 * (baked in, or --app-url), it also checks the report's Bitcoin timestamp
 * (#66) and prints it as `bitcoinTimestamp`; null when it was not asked.
 * For a file that matches a distribution copy it checks the firm's electronic
 * seal against the roots baked in, or those in --seal-roots (#120), and prints
 * it as `seal`; null for any other file. Neither changes the verdict.
 * With --reanchor (#65), a file the registry holds no record of is checked
 * against a retired registry's archive or a record's proof, through its root
 * on this registry; `reanchored` then says which root, and is null otherwise.
 * Exit status: 0 a verdict was reached, 3 cannot verify right now, 2 usage.
 */

declare const __VERIFIER_SETUP__: StandaloneSetup | null;

function usage(message: string): never {
  process.stderr.write(`${message}\nusage: verify-report <file.pdf> [--deployment <file> --rpc <url> --rpc <url>] [--app-url <url>] [--seal-roots <pem>] [--reanchor <archive or proof>]...\n`);
  process.exit(2);
}

function setupOf(values: { deployment?: string; rpc?: string[]; 'app-url'?: string }): StandaloneSetup {
  const appUrl = values['app-url']?.replace(/\/+$/, '');
  if (values.deployment || values.rpc) {
    if (!values.deployment || values.rpc?.length !== 2) usage('--deployment and two --rpc endpoints go together');
    try {
      return setupFromDeployment(JSON.parse(fs.readFileSync(values.deployment, 'utf8')), [values.rpc[0], values.rpc[1]], appUrl ?? null);
    } catch {
      usage(`${values.deployment} is not a readable deployment record, or an --rpc or --app-url value is not a URL`);
    }
  }
  if (!__VERIFIER_SETUP__) usage('this build carries no registry settings; give --deployment and two --rpc endpoints');
  try {
    return StandaloneSetupSchema.parse(appUrl === undefined ? __VERIFIER_SETUP__ : { ...__VERIFIER_SETUP__, appUrl });
  } catch {
    usage('--app-url is not an http(s) origin');
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { deployment: { type: 'string' }, rpc: { type: 'string', multiple: true }, 'app-url': { type: 'string' }, 'seal-roots': { type: 'string' }, reanchor: { type: 'string', multiple: true } } });
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length !== 1) usage('give exactly one PDF');
  const file = parsed.positionals[0];
  const setup = setupOf(parsed.values);
  let roots: Uint8Array[] = rootsOf(setup);
  if (parsed.values['seal-roots']) {
    try {
      roots = certificatesFromPem(fs.readFileSync(parsed.values['seal-roots'], 'utf8'));
    } catch {
      usage(`${parsed.values['seal-roots']} is not a readable PEM file of certificates`);
    }
  }
  const sets: CheckedSet[] = [];
  for (const reanchor of parsed.values.reanchor ?? []) {
    try {
      sets.push(checkReanchorSet(JSON.parse(fs.readFileSync(reanchor, 'utf8'))));
    } catch (error) {
      usage(`${reanchor} is not a re-anchor archive or proof that holds together${error instanceof CannotVerify ? `: ${error.message}` : ''}`);
    }
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(file));
  } catch {
    usage(`${file} cannot be read`);
  }
  const { verdict, reanchored } = await verifyWithReanchors({
    bytes,
    config: setup,
    openView: () => openRegistryView(setup),
    readPdf: (pdf) => readDocument(pdfjs as unknown as PdfjsLike, pdf),
    sets,
  });
  const bitcoinTimestamp = 'matched' in verdict && setup.appUrl ? await bitcoinTimestampFor(verdict.matched.manifestHash, { fetchProof: issuerProofFetcher(setup.appUrl), explorers: defaultExplorers() }) : null;
  const seal = 'matched' in verdict && verdict.matched.kind === 'DISTRIBUTION_COPY' ? await sealStatusFor(bytes, roots) : null;
  process.stdout.write(`${verdictJson({ file: path.basename(file), verdict, reanchored, bitcoinTimestamp, seal })}\n`);
  process.exit(verdict.kind === 'CANNOT_VERIFY' ? 3 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write(`verify-report failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
});
