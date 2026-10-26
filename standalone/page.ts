import * as pdfjs from 'pdfjs-dist';
import { explorerAddressUrl, explorerBlockUrl, explorerTxUrl, networkNameOf } from '@/lib/chain/explorer';
import { bitcoinTimestampFor, defaultExplorers, issuerProofFetcher, openRegistryView, readDocument, verifyFile, type BitcoinTimestamp, type PdfjsLike, type RecordSummary, type Verdict } from '@/lib/verify-core';
import { sealStatusFor, type SealStatus } from '@/lib/verify-core/seal';
import { rootsOf, type StandaloneSetup } from './config';

/**
 * The verifier as one HTML file (dist/verifier.html), for when the app is
 * down or not trusted: open it from disk or any static host, drop a PDF, and
 * it reads the registry through two public endpoints. Everything it needs is
 * inlined at build time: verify-core, pdf.js and its worker, the registry
 * settings and the English and Bulgarian wording. Its CSP allows connections
 * to the two endpoints only, and, when it was built with the issuer's origin,
 * to that origin's /ots route and the two Bitcoin explorers, for a matched
 * report's Bitcoin timestamp (#66). A matched distribution copy's electronic
 * seal is checked against the roots baked in (#120), offline. It writes text,
 * never markup, into the page.
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
type Checked = { name: string; verdict: Shown; stamp?: BitcoinTimestamp | 'CHECKING'; seal?: SealStatus | 'CHECKING' };
let last: Checked | null = null;

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
  if (last.stamp) box.append(stampSection(last.stamp));
  if (last.seal) box.append(sealSection(last.seal));
  out.append(box);
}

const STAMP_TONE: Record<BitcoinTimestamp['status'], string> = { CONFIRMED: 'ok', PENDING: 'muted', NONE: 'muted', UNAVAILABLE: 'muted', INVALID: 'bad' };

/** The matched report's Bitcoin timestamp, beside the verdict and never part of it. */
function stampSection(stamp: BitcoinTimestamp | 'CHECKING'): HTMLElement {
  const section = el('section', undefined, { class: 'record', 'data-testid': 'bitcoin-timestamp', 'data-status': stamp === 'CHECKING' ? 'CHECKING' : stamp.status });
  section.append(el('h3', t('bitcoin.title')));
  if (stamp === 'CHECKING') {
    section.append(el('p', t('bitcoin.checking'), { class: 'muted' }));
  } else if (stamp.status === 'CONFIRMED') {
    section.append(el('p', t('bitcoin.CONFIRMED', { when: utcDate(stamp.time), height: stamp.height }), { class: 'ok', 'data-testid': 'bitcoin-timestamp-body' }));
    const block = el('p', `${t('bitcoin.block')}: `);
    block.append(el('code', stamp.blockHash), document.createTextNode(' '), link(`https://mempool.space/block/${stamp.blockHash.slice(2)}`, t('bitcoin.block')));
    section.append(block);
  } else {
    const text = stamp.status === 'UNAVAILABLE' || stamp.status === 'INVALID' ? t(`bitcoin.${stamp.status}`, { reason: t(`bitcoin.reasons.${stamp.reason}`) }) : t(`bitcoin.${stamp.status}`);
    section.append(el('p', text, { class: STAMP_TONE[stamp.status], 'data-testid': 'bitcoin-timestamp-body' }));
  }
  section.append(el('p', t('bitcoin.apart'), { class: 'muted' }));
  return section;
}

const SEAL_TONE: Record<SealStatus['status'], string> = { SEALED: 'ok', NOT_SEALED: 'muted', NO_ROOTS: 'muted', INVALID: 'bad' };
const SEAL_CHECK_REASONS = new Set(['NOT_WHOLE_FILE', 'MALFORMED', 'DIGEST_MISMATCH', 'BAD_SIGNATURE', 'WRONG_CERTIFICATE', 'UNTRUSTED', 'BAD_TIMESTAMP']);

/** A matched copy's electronic seal, beside the verdict and never part of it. */
function sealSection(seal: SealStatus | 'CHECKING'): HTMLElement {
  const section = el('section', undefined, { class: 'record', 'data-testid': 'seal', 'data-status': seal === 'CHECKING' ? 'CHECKING' : seal.status });
  section.append(el('h3', t('seal.title')));
  if (seal === 'CHECKING') {
    section.append(el('p', t('seal.checking'), { class: 'muted' }));
  } else {
    const text =
      seal.status === 'SEALED'
        ? t('seal.SEALED', { signer: seal.signer, when: utcDate(seal.sealedAt) })
        : seal.status === 'INVALID'
          ? t('seal.INVALID', { reason: t(`seal.reasons.${SEAL_CHECK_REASONS.has(seal.reason) ? seal.reason : 'MALFORMED'}`) })
          : t(`seal.${seal.status}`);
    section.append(el('p', text, { class: SEAL_TONE[seal.status], 'data-testid': 'seal-body' }));
  }
  section.append(el('p', t('seal.apart'), { class: 'muted' }));
  return section;
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
  let bytes = new Uint8Array(0);
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
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
  const copy = 'matched' in verdict && verdict.matched.kind === 'DISTRIBUTION_COPY';
  const current: Checked = { name: file.name, verdict, stamp: 'matched' in verdict && setup.appUrl ? 'CHECKING' : undefined, seal: copy ? 'CHECKING' : undefined };
  last = current;
  renderVerdict();
  if (copy) {
    const seal = await sealStatusFor(bytes, rootsOf(setup)).catch((): SealStatus => ({ status: 'INVALID', reason: 'MALFORMED' }));
    if (last !== current) return;
    current.seal = seal;
    renderVerdict();
  }
  if ('matched' in verdict && setup.appUrl) {
    const stamp = await bitcoinTimestampFor(verdict.matched.manifestHash, { fetchProof: issuerProofFetcher(setup.appUrl), explorers: defaultExplorers() }).catch(
      (): BitcoinTimestamp => ({ status: 'UNAVAILABLE', reason: 'ISSUER_UNREACHABLE' }),
    );
    // A file dropped meanwhile has replaced this one.
    if (last !== current) return;
    current.stamp = stamp;
    renderVerdict();
  }
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
