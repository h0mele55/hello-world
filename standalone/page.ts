import * as pdfjs from 'pdfjs-dist';
import { explorerAddressUrl, explorerBlockUrl, explorerTxUrl, networkNameOf } from '@/lib/chain/explorer';
import { openRegistryView, readDocument, verifyFile, type PdfjsLike, type RecordSummary, type Verdict } from '@/lib/verify-core';
import type { StandaloneSetup } from './config';

/**
 * The verifier as one HTML file (dist/verifier.html), for when the app is
 * down or not trusted: open it from disk or any static host, drop a PDF, and
 * it reads the registry through two public endpoints. Everything it needs is
 * inlined at build time: verify-core, pdf.js and its worker, the registry
 * settings and the English and Bulgarian wording. Its CSP allows connections
 * to the two endpoints only. It writes text, never markup, into the page.
 */

type Tree = { [key: string]: string | Tree };
declare const __VERIFIER_SETUP__: StandaloneSetup;
declare const __PDF_WORKER__: string;
declare const __MESSAGES__: { en: Tree; bg: Tree };

type Locale = keyof typeof __MESSAGES__;
type Shown = Verdict | { kind: 'CANNOT_VERIFY'; reason: 'UNEXPECTED' };

const setup = __VERIFIER_SETUP__;
pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([__PDF_WORKER__], { type: 'text/javascript' }));

let locale: Locale = navigator.language.toLowerCase().startsWith('bg') ? 'bg' : 'en';
let last: { name: string; verdict: Shown } | null = null;

function t(key: string, values: Record<string, string | number> = {}): string {
  let node: string | Tree | undefined = __MESSAGES__[locale];
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  if (typeof node !== 'string') return key;
  return node.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, text?: string, attrs: Record<string, string> = {}): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function link(href: string | null, label: string): HTMLElement {
  if (!href) return el('span', `(${t('details.noExplorer')})`, { class: 'muted' });
  return el('a', '↗', { href, target: '_blank', rel: 'noreferrer', 'aria-label': label });
}

const utcDate = (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function issuerLabel(orgId: string | null) {
  return orgId === null ? t('details.noIssuer') : (setup.issuers[orgId.toLowerCase()] ?? t('details.unknownIssuer', { orgId }));
}

function recordSection(title: string, record: RecordSummary, testId: string): HTMLElement {
  const section = el('section', undefined, { class: 'record', 'data-testid': testId });
  section.append(el('h3', title));
  const head = el('p', `${t('details.version', { version: record.version })} · ${t(`details.kind.${record.kind}`)}`);
  if (record.revoked) head.append(el('span', ` · ${t('details.revokedReason', { code: record.revokeReason })}`, { class: 'bad' }));
  else if (record.revokeReason !== 0) {
    head.append(el('span', ` · ${t('details.revocationPending', { code: record.revokeReason, when: utcDate(record.revokeEffectiveAt) })}`, { class: 'warn', 'data-testid': `${testId}-revocation-pending` }));
  }
  section.append(head);
  const block = el('p', `${t('details.block', { block: record.blockNumber })}, ${utcDate(record.blockTime)} `);
  block.append(link(explorerBlockUrl(setup.chainId, record.blockNumber), t('details.block', { block: record.blockNumber })));
  section.append(block);
  if (record.txHash) {
    const tx = el('p', `${t('details.transaction')}: `);
    tx.append(el('code', record.txHash), document.createTextNode(' '), link(explorerTxUrl(setup.chainId, record.txHash), t('details.transaction')));
    section.append(tx);
  }
  section.append(el('p', `${t('details.issuer')}: ${issuerLabel(record.orgId)}`, { 'data-testid': `${testId}-issuer` }));
  return section;
}

function bodyOf(verdict: Shown): string {
  switch (verdict.kind) {
    case 'AUTHENTIC_SUPERSEDED':
      return t('verdict.AUTHENTIC_SUPERSEDED.body', { latest: verdict.latest.version });
    case 'REVOCATION_PENDING':
      return t('verdict.REVOCATION_PENDING.body', { when: utcDate(verdict.pending.revokeEffectiveAt) });
    case 'UNKNOWN_REGISTRY':
      return t('verdict.UNKNOWN_REGISTRY.body', { chainId: verdict.claimedChainId, contract: verdict.claimedContract });
    case 'NOT_REGISTERED':
      return t('verdict.NOT_REGISTERED.body', { note: t(`notRegistered.${verdict.note}`) });
    case 'CANNOT_VERIFY':
      return t('verdict.CANNOT_VERIFY.body', { reason: t(`cannotVerify.${verdict.reason}`) });
    default:
      return t(`verdict.${verdict.kind}.body`);
  }
}

const TONE: Record<Shown['kind'], string> = {
  AUTHENTIC_LATEST: 'good',
  AUTHENTIC_SUPERSEDED: 'warn',
  REVOKED: 'bad',
  REVOCATION_PENDING: 'warn',
  ALTERED_OPINION_CHANGED: 'bad',
  ALTERED_OPINION_APPEARS_UNCHANGED: 'warn',
  ALTERED_OPINION_NOT_CHECKABLE: 'warn',
  UNKNOWN_REGISTRY: 'neutral',
  NOT_REGISTERED: 'neutral',
  CANNOT_VERIFY: 'neutral',
};

function renderVerdict() {
  const out = $('result');
  out.replaceChildren();
  if (!last) return;
  const { name, verdict } = last;
  const box = el('div', undefined, { 'data-testid': 'verdict', 'data-kind': verdict.kind, class: `verdict ${TONE[verdict.kind]}` });
  box.append(el('p', name, { class: 'muted' }), el('h2', t(`verdict.${verdict.kind}.title`)), el('p', bodyOf(verdict), { 'data-testid': 'verdict-body' }));
  if ('docHash' in verdict) {
    box.append(el('h3', t('details.heading')));
    const hash = el('p', `${t('details.fileHash')}: `);
    hash.append(el('code', verdict.docHash, { 'data-testid': 'file-hash' }));
    box.append(hash);
    const seen = new Set<string>();
    const add = (title: string, record: RecordSummary, testId: string) => {
      if (seen.has(record.recordId)) return;
      seen.add(record.recordId);
      box.append(recordSection(title, record, testId));
    };
    if ('matched' in verdict) add(t('details.matched'), verdict.matched, 'record-matched');
    if ('claimed' in verdict) add(t('details.claimed'), verdict.claimed, 'record-claimed');
    if ('original' in verdict) add(t('details.original'), verdict.original, 'record-original');
    if ('latest' in verdict) add(t('details.latest'), verdict.latest, 'record-latest');
    box.append(el('p', t('details.asOf', { block: verdict.asOfBlock }), { class: 'muted' }));
  }
  out.append(box);
}

function renderStatic() {
  document.documentElement.lang = locale;
  document.title = t('title');
  $('title').textContent = t('title');
  $('intro').textContent = t('intro');
  $('disclaimer').textContent = t('disclaimer');
  $('drop-title').textContent = t('dropTitle');
  $('choose-label').textContent = t('choose');
  $('file').setAttribute('aria-label', t('fileLabel'));
  const registry = $('registry');
  registry.textContent = `${t('checksAgainst', { contract: setup.registry, network: networkNameOf(setup.chainId) })} `;
  registry.append(link(explorerAddressUrl(setup.chainId, setup.registry), t('details.registry')));
  for (const option of ['en', 'bg'] as const) $(`locale-${option}`).setAttribute('aria-pressed', String(option === locale));
  renderVerdict();
}

async function check(file: File) {
  last = null;
  renderVerdict();
  $('status').textContent = t('checking', { name: file.name });
  let verdict: Shown;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    verdict = await verifyFile({
      bytes,
      config: setup,
      openView: () => openRegistryView(setup),
      readPdf: (pdf) => readDocument(pdfjs as unknown as PdfjsLike, pdf),
    });
  } catch {
    verdict = { kind: 'CANNOT_VERIFY', reason: 'UNEXPECTED' };
  }
  $('status').textContent = '';
  last = { name: file.name, verdict };
  renderVerdict();
}

$<HTMLInputElement>('file').addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void check(file);
});
const zone = $('drop');
zone.addEventListener('dragover', (event) => {
  event.preventDefault();
  zone.classList.add('dragging');
});
zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
zone.addEventListener('drop', (event) => {
  event.preventDefault();
  zone.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) void check(file);
});
for (const option of ['en', 'bg'] as const) {
  $(`locale-${option}`).addEventListener('click', () => {
    locale = option;
    renderStatic();
  });
}
renderStatic();
