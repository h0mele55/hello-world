import type { PositionedLine } from './lines.mjs';

export interface PdfDocumentLike {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): unknown }>;
}

export type ReadPages = { tooMuchText: true } | { tooMuchText: false; pages: { lines: PositionedLine[] }[]; textChars: number };

export function readPages(doc: PdfDocumentLike, maxTextChars: number): Promise<ReadPages>;
