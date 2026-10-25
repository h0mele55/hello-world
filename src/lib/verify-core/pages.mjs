// Reads every page's text, as lines in reading order, from an open pdf.js
// document. Shared by the isolated server parser and the browser verifier, so
// both see the same lines. Plain JavaScript: Node runs it with no loader.
import { linesOf } from './lines.mjs';

/**
 * Stops as soon as the document holds more than `maxTextChars` characters
 * that are not whitespace, so a hostile file cannot make it read on and on.
 */
export async function readPages(doc, maxTextChars) {
  const pages = [];
  let textChars = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const lines = linesOf(content.items);
    for (const line of lines) textChars += line.text.replace(/\s/g, '').length;
    if (textChars > maxTextChars) return { tooMuchText: true };
    pages.push({ lines });
    page.cleanup();
  }
  return { tooMuchText: false, pages, textChars };
}
