/**
 * Bundled by esbuild for tests/e2e/golden-browser.spec.ts: verify-core and
 * pdf.js's browser build, exposed on window so a blank page can run the
 * golden fixtures through exactly the code the verifier ships.
 */
import * as pdfjs from 'pdfjs-dist';
import { docHashOf, dropRunningLines, locateOpinion, opinionCommitmentOf, readDocument, type PdfjsLike } from '@/lib/verify-core';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

async function golden(bytes: Uint8Array, salt: Uint8Array) {
  const docHash = docHashOf(bytes);
  const read = await readDocument(pdfjs as unknown as PdfjsLike, bytes);
  if (!read.ok) return { docHash, refused: read.reason };
  const located = locateOpinion(dropRunningLines(read.doc.pageLines));
  if (located.status === 'NOT_FOUND') return { docHash, notFound: located.reason };
  return { docHash, type: located.type, text: located.text, opinionCommitment: opinionCommitmentOf({ salt, type: located.type, text: located.text }) };
}

(window as unknown as { verifyCoreGolden: typeof golden }).verifyCoreGolden = golden;
