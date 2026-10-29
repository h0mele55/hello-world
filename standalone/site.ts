import { createHash } from 'node:crypto';
import { z } from 'zod';
import bgMessages from '../messages/bg.json';
import enMessages from '../messages/en.json';
import { explorerAddressUrl, networkNameOf } from '../src/lib/chain/explorer';
import { isNetworkName, PRODUCTION_NETWORKS } from '../src/lib/chain/networks';

/**
 * The published single-file verifier (#85): what the GitHub Pages site and
 * the release carry, made from the two files `npm run build:verifier` wrote.
 *
 *   index.html            what the file is, its SHA-256, its release, and how to check a kept copy
 *   verifier.html         the file itself, byte for byte
 *   verifier.html.sha256  its hash, in sha256sum's format
 *
 * plus the release's notes. Everything said about the file comes from
 * dist/verifier.json, whose hash must be the file's own, so the site cannot
 * describe another build. The release is named by the hash
 * (verifier-<network>-<first 12 hex digits>), so an unchanged file never makes
 * a second release. Nothing here runs a script: index.html is plain HTML under
 * a CSP that allows its one style and nothing else.
 */

export const BuiltVerifierSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  network: z.string().refine(isNetworkName, 'not a network in NETWORKS'),
  chainId: z.int().positive(),
  registry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  connectsTo: z.array(z.url({ protocol: /^https?$/ })).min(1),
  appUrl: z.url({ protocol: /^https?$/ }).nullable(),
  sealRoots: z.int().min(0),
  reanchorArchives: z.int().min(0),
});

export type BuiltVerifier = z.infer<typeof BuiltVerifierSchema>;

export interface VerifierSiteInput {
  /** dist/verifier.html, as written. */
  html: Uint8Array;
  /** dist/verifier.json, parsed. */
  built: unknown;
  /** owner/name on GitHub, where the release is made. */
  repo: string;
  /** The commit the file was built from. */
  commit: string;
}

export interface VerifierSite {
  sha256: string;
  tag: string;
  releaseUrl: string;
  /** Path in the site -> contents. */
  files: Record<string, Uint8Array>;
  /** The release's description, in Markdown. */
  notes: string;
}

export class VerifierSiteError extends Error {}

const STYLE = `:root{color-scheme:light dark;--bg:#fbfaf7;--ink:#1d1c1a;--muted:#5f5b53;--line:#e2ded5;--accent:#2b6a55;--note:#fbefd4;--note-ink:#5f4000}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--ink:#edebe6;--muted:#a6a298;--line:#312f2b;--accent:#7cc3a8;--note:#3a2e14;--note-ink:#f2d08a}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 48px}
section+section{margin-top:48px;padding-top:32px;border-top:1px solid var(--line)}
h1{font-size:26px;line-height:1.25;margin:0 0 12px}
h2{font-size:17px;margin:28px 0 8px}
p,ul{margin:0 0 12px}
a{color:var(--accent)}
.button{display:inline-block;padding:10px 16px;border-radius:8px;background:var(--accent);color:var(--bg);font-weight:600;text-decoration:none}
code,pre{font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-size:14px}
pre{margin:0 0 12px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
li{overflow-wrap:anywhere}
.muted{color:var(--muted)}
.notice{padding:10px 12px;border-radius:8px;background:var(--note);color:var(--note-ink)}`;

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TEXT = {
  en: {
    title: enMessages.verify.title,
    intro: (network: string) =>
      `This verifier checks a PDF against its record in the registry on ${network}. It runs entirely in your browser: the file is never uploaded, and the verdict does not depend on the issuer's site.`,
    open: 'Open the verifier',
    keepTitle: 'Keep your own copy',
    keep: (download: string, release: string) =>
      `Download <a href="${download}">verifier.html</a> from <a href="${release}">its release</a> and open it from your own disk. Before you rely on a copy, check that its SHA-256 is:`,
    commands:
      'On macOS or Linux: <code>shasum -a 256 verifier.html</code>. On Windows, in PowerShell: <code>Get-FileHash verifier.html</code>, which prints the same digits in capitals.',
    readsTitle: 'What it reads',
    registry: (registry: string, network: string, chainId: number) => `Registry ${registry} on ${network} (chain id ${chainId})`,
    connects: 'It connects only to',
    commit: 'Built from commit',
    disclaimer: enMessages.verify.disclaimer,
  },
  bg: {
    title: bgMessages.verify.title,
    intro: (network: string) =>
      `Тази проверка сравнява PDF файл със записа му в регистъра в ${network}. Тя се извършва изцяло във вашия браузър: файлът не се качва никъде, а резултатът не зависи от сайта на издателя.`,
    open: 'Отворете проверката',
    keepTitle: 'Пазете собствено копие',
    keep: (download: string, release: string) =>
      `Изтеглете <a href="${download}">verifier.html</a> от <a href="${release}">неговото издание</a> и го отворете от собствения си диск. Преди да разчитате на копие, проверете, че неговият SHA-256 е:`,
    commands:
      'В macOS или Linux: <code>shasum -a 256 verifier.html</code>. В Windows, в PowerShell: <code>Get-FileHash verifier.html</code>, което извежда същите цифри с главни букви.',
    readsTitle: 'Какво чете',
    registry: (registry: string, network: string, chainId: number) => `Регистър ${registry} в ${network} (идентификатор на веригата ${chainId})`,
    connects: 'Свързва се само с',
    commit: 'Създаден от къмит',
    disclaimer: bgMessages.verify.disclaimer,
  },
} as const;

function section(lang: 'en' | 'bg', built: BuiltVerifier, links: { download: string; release: string; commit: string; registry: string | null }, commit: string, testnet: boolean): string {
  const t = TEXT[lang];
  const network = escape(networkNameOf(built.chainId));
  const registry = links.registry ? `<a href="${escape(links.registry)}"><code>${escape(built.registry)}</code></a>` : `<code>${escape(built.registry)}</code>`;
  return [
    `<section lang="${lang}">`,
    `<h1>${t.title}</h1>`,
    `<p>${t.intro(network)}</p>`,
    `<p><a class="button" href="verifier.html">${t.open}</a></p>`,
    `<h2>${t.keepTitle}</h2>`,
    `<p>${t.keep(escape(links.download), escape(links.release))}</p>`,
    `<pre>${built.sha256}</pre>`,
    `<p class="muted">${t.commands}</p>`,
    `<h2>${t.readsTitle}</h2>`,
    '<ul>',
    `<li>${t.registry(registry, network, built.chainId)}</li>`,
    `<li>${t.connects}: ${built.connectsTo.map((origin) => `<code>${escape(origin)}</code>`).join(', ')}</li>`,
    `<li>${t.commit} <a href="${escape(links.commit)}"><code>${commit.slice(0, 12)}</code></a></li>`,
    '</ul>',
    testnet ? `<p class="notice">${escape(t.disclaimer)}</p>` : '',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function verifierSite(input: VerifierSiteInput): VerifierSite {
  const parsed = BuiltVerifierSchema.safeParse(input.built);
  if (!parsed.success) throw new VerifierSiteError(`dist/verifier.json does not describe a build: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const built = parsed.data;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(input.repo)) throw new VerifierSiteError(`${input.repo} is not a GitHub owner/name`);
  if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new VerifierSiteError(`${input.commit} is not a full commit hash`);
  const sha256 = createHash('sha256').update(input.html).digest('hex');
  if (sha256 !== built.sha256) throw new VerifierSiteError('dist/verifier.json describes another file than dist/verifier.html: run npm run build:verifier again');

  const tag = `verifier-${built.network}-${sha256.slice(0, 12)}`;
  const base = `https://github.com/${input.repo}`;
  const links = {
    release: `${base}/releases/tag/${tag}`,
    download: `${base}/releases/download/${tag}/verifier.html`,
    commit: `${base}/commit/${input.commit}`,
    registry: explorerAddressUrl(built.chainId, built.registry),
  };
  const testnet = !(PRODUCTION_NETWORKS as readonly string[]).includes(built.network);
  const styleHash = createHash('sha256').update(STYLE, 'utf8').digest('base64');
  const csp = `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'`;
  const index = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    `<title>${TEXT.en.title} · ${TEXT.bg.title}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    section('en', built, links, input.commit, testnet),
    section('bg', built, links, input.commit, testnet),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  const notes = [
    `The single-file verifier for **${networkNameOf(built.chainId)}** (chain id ${built.chainId}), built from ${input.commit}.`,
    '',
    'SHA-256 of `verifier.html`:',
    '',
    `    ${sha256}`,
    '',
    'Check a copy before relying on it: `shasum -a 256 verifier.html` on macOS or Linux, `Get-FileHash verifier.html` in Windows PowerShell, or `sha256sum -c verifier.html.sha256` with both files in one folder.',
    '',
    `- Registry: \`${built.registry}\`${links.registry ? ` (${links.registry})` : ''}`,
    `- Connects only to: ${built.connectsTo.map((origin) => `\`${origin}\``).join(', ')}`,
    `- Electronic-seal roots: ${built.sealRoots}; re-anchor archives: ${built.reanchorArchives}`,
    '',
    'It runs in the browser: the file checked is never uploaded, and the verdict does not depend on the issuer’s site.',
    ...(testnet ? ['', TEXT.en.disclaimer] : []),
    '',
  ].join('\n');

  const encode = (text: string) => new TextEncoder().encode(text);
  return {
    sha256,
    tag,
    releaseUrl: links.release,
    files: {
      'index.html': encode(index),
      'verifier.html': input.html,
      'verifier.html.sha256': encode(`${sha256}  verifier.html\n`),
    },
    notes,
  };
}
