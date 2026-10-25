/** A pdf.js text item, as `page.getTextContent()` returns it. */
export interface TextItemLike {
  str?: unknown;
  transform: number[];
  width: number;
  height?: number;
}

export interface PositionedLine {
  text: string;
  x: number;
  y: number;
  size: number;
}

/** Lines in reading order: band by band down the page, column by column within a band. */
export function linesOf(items: readonly TextItemLike[]): PositionedLine[];
