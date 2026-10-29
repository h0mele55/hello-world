/**
 * Builds the standalone verifiers from src/lib/verify-core:
 *
 *   dist/verifier.html     one self-contained page: open it from disk or any static host
 *   dist/verify-report.mjs the CLI that bin/verify-report.mjs runs
 *
 *   npm run build:verifier               both; the HTML needs registry settings
 *   npm run build:verifier -- --cli-only the CLI alone, settings optional
 *
 * The registry settings come from the same environment as /verify
 * (VERIFY_NETWORK or ANCHOR_NETWORK, VERIFY_RPC_URL_1/2, the deployment
 * record) and are baked into both outputs. They are public by definition.
 * APP_PUBLIC_URL, when set, is the issuer's origin: both outputs ask its /ots
 * route for a matched report's Bitcoin timestamp (#66), and the HTML file's
 * CSP then allows it and the two Bitcoin explorers too.
 * REANCHOR_ARCHIVES, when set, lists the re-anchor archives or proofs of the
 * registries this one replaced (#65); both outputs carry them, so a file
 * anchored on a retired chain verifies with no server and that chain gone
 * (#126). Each must hold together and have its root on this registry, or the
 * build is refused.
 *
 * Beside the HTML file it writes dist/verifier.json, what was built: the
 * file's SHA-256, the network and registry, and every origin the file may
 * connect to. scripts/verifier-site.ts publishes the file from that record
 * (#85), so the published description is of this build and no other.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { EXPLORER_ORIGINS } from '../src/lib/ots/explorers';
import { checkReanchorSet } from '../src/lib/verify-core/reanchor';
import { reanchorArchivesOf, verifierSetupFromEnv } from '../src/lib/verify-setup';
import type { StandaloneSetup } from '../standalone/config';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const cliOnly = process.argv.includes('--cli-only');

const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

function refuse(message: string): never {
  console.error(`Refused: ${message}`);
  process.exit(1);
}

/** The re-anchor archives, as published: each held together and rooted on this verifier's registry, or the build stops. */
function reanchorSetsFor(setup: StandaloneSetup): unknown[] {
  return reanchorArchivesOf().map((file) => {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      refuse(`${file} (REANCHOR_ARCHIVES) cannot be read as JSON.`);
    }
    let set;
    try {
      set = checkReanchorSet(json);
    } catch (error) {
      refuse(`${file} (REANCHOR_ARCHIVES) does not hold together: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!set.target) refuse(`${file} (REANCHOR_ARCHIVES) is a checkpoint; give it to the CLI with --checkpoint.`);
    if (set.target.chainId !== setup.chainId || set.target.registry.toLowerCase() !== setup.registry.toLowerCase()) {
      refuse(`${file} (REANCHOR_ARCHIVES) has its root on registry ${set.target.registry} (chain ${set.target.chainId}), not this verifier's.`);
    }
    return json;
  });
}

async function main() {
  const appUrl = process.env.APP_PUBLIC_URL ? process.env.APP_PUBLIC_URL.replace(/\/+$/, '') : null;
  if (appUrl && !/^https?:\/\/[^\s/]+$/.test(appUrl)) {
    console.error('Refused: APP_PUBLIC_URL must be an http(s) origin, with no path.');
    process.exit(1);
  }
  const result = verifierSetupFromEnv();
  const network = result.ok ? result.setup.network : null;
  const setup: StandaloneSetup | null = result.ok
    ? {
        chainId: result.setup.chainId,
        registry: result.setup.registry,
        runtimeBytecodeHash: result.setup.runtimeBytecodeHash,
        rpcUrls: [...result.setup.rpcUrls],
        issuers: result.setup.issuers,
        appUrl,
        // SEAL_TRUST_ANCHORS, the worker's PEM file of public roots: a matched copy's seal is checked against them (#120).
        sealRoots: result.setup.sealRoots,
      }
    : null;
  if (!setup && !cliOnly) {
    console.error(`Refused: the HTML verifier needs registry settings (${result.ok ? '' : result.reason}). Use --cli-only to build the CLI alone.`);
    process.exit(1);
  }
  const reanchorSets = setup ? reanchorSetsFor(setup) : [];
  fs.mkdirSync(DIST, { recursive: true });

  await build({
    entryPoints: [path.join(ROOT, 'standalone', 'cli.ts')],
    outfile: path.join(DIST, 'verify-report.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // pdf.js finds its own worker module next to itself, so it stays in node_modules.
    external: ['pdfjs-dist', 'pdfjs-dist/*'],
    define: { __VERIFIER_SETUP__: JSON.stringify(setup), __REANCHOR_SETS__: JSON.stringify(reanchorSets) },
    // A CommonJS dependency of the seal check (#120) requires Node's built-ins, which an ES module can do only through createRequire.
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  console.log(`wrote dist/verify-report.mjs${setup ? ` (chain ${setup.chainId}, ${setup.registry}, ${setup.sealRoots.length} seal root(s), ${reanchorSets.length} re-anchor archive(s))` : ' (no baked settings)'}`);
  if (cliOnly || !setup) return;

  const messages = { en: JSON.parse(read('messages', 'en.json')).verify, bg: JSON.parse(read('messages', 'bg.json')).verify };
  const bundled = await build({
    entryPoints: [path.join(ROOT, 'standalone', 'page.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    define: {
      __VERIFIER_SETUP__: JSON.stringify(setup),
      __REANCHOR_SETS__: JSON.stringify(reanchorSets),
      __PDF_WORKER__: JSON.stringify(read('node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')),
      __MESSAGES__: JSON.stringify(messages),
    },
    logLevel: 'warning',
  });
  // Inline in a <script>: no sequence in the code may close the element.
  const script = bundled.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');
  const style = read('standalone', 'style.css');
  const origins = [...new Set([...setup.rpcUrls.map((url) => new URL(url).origin), ...(setup.appUrl ? [setup.appUrl, ...EXPLORER_ORIGINS] : [])])].join(' ');
  const csp = [
    "default-src 'none'",
    // blob: is the pdf.js worker, which the page builds from its own inlined copy.
    `script-src ${sha256(script)} blob:`,
    'worker-src blob:',
    `connect-src ${origins}`,
    `style-src ${sha256(style)}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const html = read('standalone', 'template.html')
    .replace('__CSP__', () => csp)
    .replace('__STYLE__', () => style)
    .replace('__SCRIPT__', () => script);
  fs.writeFileSync(path.join(DIST, 'verifier.html'), html);
  const built = {
    sha256: createHash('sha256').update(html, 'utf8').digest('hex'),
    network,
    chainId: setup.chainId,
    registry: setup.registry,
    connectsTo: origins.split(' '),
    appUrl: setup.appUrl,
    sealRoots: setup.sealRoots.length,
    reanchorArchives: reanchorSets.length,
  };
  fs.writeFileSync(path.join(DIST, 'verifier.json'), `${JSON.stringify(built, null, 2)}\n`);
  console.log(`wrote dist/verifier.html (${Math.round(html.length / 1024)} KiB; connects only to ${origins}; SHA-256 ${built.sha256})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
