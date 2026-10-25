'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button } from '@inflect/ui/components/ui/button';

/**
 * Renders the stored PDF page by page in the browser, so the person confirming
 * the opinion reads it beside the report itself. pdf.js runs in its worker
 * (served from /pdf.worker.min.mjs); the file comes from the authenticated,
 * uncached file route.
 */
export function PdfViewer({ src, initialPage = 1 }: { src: string; initialPage?: number }) {
  const t = useTranslations('viewer');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | null = null;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const response = await fetch(src, { cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        const task = pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) });
        destroy = () => task.destroy();
        const loaded = await task.promise;
        if (!cancelled) setDoc(loaded);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      void destroy?.();
    };
  }, [src]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      const pdfPage = await doc.getPage(page);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const width = canvas.parentElement?.clientWidth ?? 600;
      const unscaled = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: (width / unscaled.width) * window.devicePixelRatio });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${width}px`;
      task = pdfPage.render({ canvas, viewport });
      await task.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page]);

  if (failed) return <p className="text-content-error">{t('failed')}</p>;
  const pageCount = doc?.numPages ?? 0;
  return (
    <div className="flex flex-col gap-compact" data-testid="pdf-viewer">
      <div className="flex items-center justify-between gap-tight">
        <Button type="button" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          {t('previous')}
        </Button>
        <span className="text-content-muted" data-testid="pdf-page">
          {doc ? t('page', { page, pageCount }) : t('loading')}
        </span>
        <Button type="button" variant="secondary" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
          {t('next')}
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border border-border-subtle bg-white">
        <canvas ref={canvasRef} aria-label={t('canvasLabel', { page })} />
      </div>
    </div>
  );
}
