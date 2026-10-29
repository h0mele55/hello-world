import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import QRCode from 'qrcode';
import { z } from 'zod';

/**
 * The one-page verification certificate for an anchor-only version: a report
 * that is signed or edit-protected, so it is anchored as issued and never
 * stamped (#74). It says, in English and Bulgarian, where the anchor is and
 * how to check it, with a QR code to the verifier, and, when the firm publishes
 * one, where the single-file verifier is (#85): the way to check without the
 * firm's site. The certificate itself is not anchored: it points at the
 * record, and the record vouches for the report, not for the certificate.
 *
 * Deterministic: the same input gives the same bytes. No dates.
 */

const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);

export const CertificateInputSchema = z.strictObject({
  version: z.int().min(1),
  docHash: bytes32,
  recordId: bytes32,
  familyId: bytes32,
  chainId: z.int().min(1),
  /** How the network is named on the page, e.g. "Ethereum Sepolia". */
  networkName: z.string().min(1).max(60),
  contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  txHash: bytes32.nullable(),
  blockNumber: z.int().min(1),
  verifyUrl: z.url().max(200),
  explorerTxUrl: z.url().max(300).nullable(),
  /** The published single-file verifier (#85); without one the page is as it was. */
  standaloneVerifierUrl: z.url({ protocol: /^https$/ }).max(200).nullable().optional(),
});

export type CertificateInput = z.infer<typeof CertificateInputSchema>;

const require = createRequire(import.meta.url);
const fontBytes = (name: string) => fs.readFileSync(require.resolve(`dejavu-fonts-ttf/ttf/${name}`));

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const INK = rgb(0.1, 0.12, 0.14);
const MUTED = rgb(0.38, 0.4, 0.44);

const TEXT = {
  title: ['Verification certificate', 'Удостоверение за проверка'],
  intro: [
    'This report is digitally signed or protected against editing, so it was anchored exactly as issued and was not modified. The record below holds the SHA-256 hash of that file. To check a copy, open the verifier and drop the report itself (not this certificate) on it: the file is hashed in your browser and never uploaded.',
    'Този доклад е подписан електронно или защитен срещу редакция, затова е закотвен точно във вида, в който е издаден, без промени. Записът по-долу съдържа SHA-256 хеша на този файл. За да проверите копие, отворете страницата за проверка и пуснете в нея самия доклад (не това удостоверение): файлът се хешира във вашия браузър и не се качва никъде.',
  ],
  version: ['Report version', 'Версия на доклада'],
  docHash: ['Document SHA-256', 'SHA-256 на документа'],
  recordId: ['Record id', 'Идентификатор на записа'],
  familyId: ['Report family id', 'Идентификатор на семейството'],
  network: ['Network', 'Мрежа'],
  contract: ['Registry contract', 'Договор на регистъра'],
  txHash: ['Transaction', 'Транзакция'],
  block: ['Block (finalized)', 'Блок (финализиран)'],
  explorer: ['Block explorer', 'Обозревател на блокове'],
  verify: ['Verify', 'Проверка'],
  standalone: [
    'Or check without this site: the single-file verifier, published with its SHA-256, runs in your browser and can be kept and opened from your own disk.',
    'Или проверете без този сайт: проверката в един файл, публикувана с нейния SHA-256, работи във вашия браузър и може да се пази и отваря от собствения ви диск.',
  ],
  footer: [
    'Anchored on a public test network: prototype evidence, not a legally binding record.',
    'Закотвено в публична тестова мрежа: доказателство от прототип, а не правно обвързващ запис.',
  ],
} as const;

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Splits a long unbroken value (a hash, a URL) to fit the width. */
function chunk(value: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const char of value) {
    if (line && font.widthOfTextAtSize(line + char, size) > width) {
      lines.push(line);
      line = '';
    }
    line += char;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The dark modules of a QR code for `text` as squares in a size × size box
 * whose lower-left corner is (x, y), in PDF coordinates (y grows upwards),
 * with the standard four-module quiet zone.
 */
export function qrSquares(text: string, x: number, y: number, size: number): { x: number; y: number; side: number }[] {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const quiet = 4;
  const side = size / (modules.size + 2 * quiet);
  const squares = [];
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) squares.push({ x: x + (col + quiet) * side, y: y + size - (row + quiet + 1) * side, side });
    }
  }
  return squares;
}

function drawQr(page: PDFPage, text: string, x: number, y: number, size: number) {
  page.drawRectangle({ x, y, width: size, height: size, color: rgb(1, 1, 1) });
  for (const square of qrSquares(text, x, y, size)) {
    page.drawRectangle({ x: square.x, y: square.y, width: square.side, height: square.side, color: rgb(0, 0, 0) });
  }
}

export async function certificatePdf(input: CertificateInput): Promise<Uint8Array> {
  const data = CertificateInputSchema.parse(input);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fontBytes('DejaVuSans.ttf'), { subset: true });
  const bold = await doc.embedFont(fontBytes('DejaVuSans-Bold.ttf'), { subset: true });
  const mono = await doc.embedFont(fontBytes('DejaVuSansMono.ttf'), { subset: true });
  doc.setTitle(`${TEXT.title[0]} / ${TEXT.title[1]}`);
  doc.setProducer('audit-anchor');

  const page = doc.addPage([A4.width, A4.height]);
  const width = A4.width - 2 * MARGIN;
  let y = A4.height - MARGIN;
  const text = (value: string, font: PDFFont, size: number, color = INK, x = MARGIN) => {
    y -= size * 1.35;
    page.drawText(value, { x, y, size, font, color });
  };

  text(TEXT.title[0], bold, 18);
  text(TEXT.title[1], bold, 14, MUTED);
  y -= 8;
  for (const [i, paragraph] of TEXT.intro.entries()) {
    for (const line of wrap(paragraph, regular, 9, width)) text(line, regular, 9, i === 0 ? INK : MUTED);
    y -= 4;
  }
  y -= 6;

  const rows: [readonly [string, string], string][] = [
    [TEXT.version, String(data.version)],
    [TEXT.docHash, data.docHash],
    [TEXT.recordId, data.recordId],
    [TEXT.familyId, data.familyId],
    [TEXT.network, `${data.networkName} (chain id ${data.chainId})`],
    [TEXT.contract, data.contract],
    ...(data.txHash ? ([[TEXT.txHash, data.txHash]] as [readonly [string, string], string][]) : []),
    [TEXT.block, String(data.blockNumber)],
    ...(data.explorerTxUrl ? ([[TEXT.explorer, data.explorerTxUrl]] as [readonly [string, string], string][]) : []),
  ];
  for (const [[en, bg], value] of rows) {
    text(`${en} / ${bg}`, bold, 8.5, MUTED);
    for (const line of chunk(value, mono, 9, width)) text(line, mono, 9);
    y -= 5;
  }

  y -= 10;
  const qrSize = 120;
  drawQr(page, data.verifyUrl, MARGIN, y - qrSize, qrSize);
  const textX = MARGIN + qrSize + 16;
  const textWidth = width - qrSize - 16;
  const top = y;
  y -= 4;
  text(`${TEXT.verify[0]} / ${TEXT.verify[1]}`, bold, 11, INK, textX);
  for (const line of chunk(data.verifyUrl, mono, 9, textWidth)) text(line, mono, 9, INK, textX);
  y = Math.min(y, top - qrSize) - 20;

  if (data.standaloneVerifierUrl) {
    for (const [i, paragraph] of TEXT.standalone.entries()) {
      for (const line of wrap(paragraph, regular, 8.5, width)) text(line, regular, 8.5, i === 0 ? INK : MUTED);
    }
    for (const line of chunk(data.standaloneVerifierUrl, mono, 9, width)) text(line, mono, 9);
    y -= 16;
  }

  for (const [i, line] of TEXT.footer.entries()) {
    for (const part of wrap(line, regular, 8, width)) text(part, regular, 8, i === 0 ? INK : MUTED);
  }
  return doc.save({ useObjectStreams: false });
}
