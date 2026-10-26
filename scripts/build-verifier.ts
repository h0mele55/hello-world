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
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { EXPLORER_ORIGINS } from '../src/lib/ots/explorers';
import { verifierSetupFromEnv } from '../src/lib/verify-setup';
import type { StandaloneSetup } from '../standalone/config';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const cliOnly = process.argv.includes('--cli-only');

const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

async function main() {
  const appUrl = process.env.APP_PUBLIC_URL ? process.env.APP_PUBLIC_URL.replace(/\/+$/, '') : null;
  if (appUrl && !/^https?:\/\/[^\s/]+$/.test(appUrl)) {
    console.error('Refused: APP_PUBLIC_URL must be an http(s) origin, with no path.');
    process.exit(1);
  }
  const result = verifierSetupFromEnv();
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
    define: { __VERIFIER_SETUP__: JSON.stringify(setup) },
    // A CommonJS dependency of the seal check (#120) requires Node's built-ins, which an ES module can do only through createRequire.
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  console.log(`wrote dist/verify-report.mjs${setup ? ` (chain ${setup.chainId}, ${setup.registry}, ${setup.sealRoots.length} seal root(s))` : ' (no baked settings)'}`);
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
  console.log(`wrote dist/verifier.html (${Math.round(html.length / 1024)} KiB; connects only to ${origins})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
