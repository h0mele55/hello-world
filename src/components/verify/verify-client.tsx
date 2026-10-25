'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState, type DragEvent } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { Card } from '@inflect/ui/components/ui/card';
import { EmptyState } from '@inflect/ui/components/ui/empty-state';
import { CloudUpload } from '@inflect/ui/components/ui/icons/nucleo/cloud-upload';
import { openRegistryView, readDocument, verifyFile, type PdfjsLike } from '@/lib/verify-core';
import type { VerifierSetup } from '@/lib/verify-setup';
import { BitcoinTimestampView } from './bitcoin-timestamp-view';
import { VerdictView, type ShownVerdict } from './verdict-view';

type State = { step: 'idle' } | { step: 'checking'; name: string } | { step: 'done'; name: string; verdict: ShownVerdict };

let pdfjsLoad: Promise<PdfjsLike> | null = null;

/** pdf.js parses in its own worker, served from this origin; nothing it reads leaves the browser. */
function loadPdfjs(): Promise<PdfjsLike> {
  pdfjsLoad ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    return pdfjs as unknown as PdfjsLike;
  });
  return pdfjsLoad;
}

/**
 * The verifier, entirely in the browser (rule 5): the file is read from disk
 * into memory, hashed, parsed by pdf.js and compared with what two RPC
 * endpoints say the registry holds. It is never sent anywhere, and nothing
 * here calls the app's own API. Once a file matches a record, the page asks
 * this site's public /ots route for that report's Bitcoin timestamp by its
 * manifest hash (#66), which only adds to the verdict.
 */
export function VerifyClient({ setup }: { setup: VerifierSetup }) {
  const t = useTranslations('verify');
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ step: 'idle' });
  const [dragging, setDragging] = useState(false);

  async function check(file: File) {
    setState({ step: 'checking', name: file.name });
    let verdict: ShownVerdict;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      verdict = await verifyFile({
        bytes,
        config: setup,
        openView: () => openRegistryView(setup),
        readPdf: async (pdf) => readDocument(await loadPdfjs(), pdf),
      });
    } catch {
      verdict = { kind: 'CANNOT_VERIFY', reason: 'UNEXPECTED' };
    }
    setState({ step: 'done', name: file.name, verdict });
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file && state.step !== 'checking') void check(file);
  }

  return (
    <Card
      className={`flex flex-col gap-default ${dragging ? 'ring-2 ring-border-emphasis' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="verify-drop-zone"
    >
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        aria-label={t('fileLabel')}
        data-testid="verify-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void check(file);
        }}
      />
      {state.step === 'idle' ? (
        <EmptyState
          icon={CloudUpload}
          title={t('dropTitle')}
          description={t('dropOr')}
          primaryAction={{ label: t('choose'), onClick: () => input.current?.click(), 'data-testid': 'verify-choose' }}
          data-testid="verify-empty"
        />
      ) : state.step === 'checking' ? (
        <p className="text-content-muted" role="status" data-testid="verify-checking">
          {t('checking', { name: state.name })}
        </p>
      ) : (
        <>
          <p className="break-all text-sm text-content-muted">{state.name}</p>
          <VerdictView verdict={state.verdict} chainId={setup.chainId} issuers={setup.issuers} />
          {'matched' in state.verdict ? <BitcoinTimestampView key={state.verdict.matched.manifestHash} manifestHash={state.verdict.matched.manifestHash} /> : null}
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setState({ step: 'idle' });
                input.current?.click();
              }}
              data-testid="verify-another"
            >
              {t('another')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
