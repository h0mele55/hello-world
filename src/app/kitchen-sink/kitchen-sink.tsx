'use client';

import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { Card } from '@inflect/ui/components/ui/card';
import { ConfirmDialog } from '@inflect/ui/components/ui/confirm-dialog';
import { CopyButton } from '@inflect/ui/components/ui/copy-button';
import { EmptyState } from '@inflect/ui/components/ui/empty-state';
import { ErrorState } from '@inflect/ui/components/ui/error-state';
import { FormField } from '@inflect/ui/components/ui/form-field';
import { Input } from '@inflect/ui/components/ui/input';
import { Modal } from '@inflect/ui/components/ui/modal';
import { Sheet } from '@inflect/ui/components/ui/sheet';
import { SkeletonCard } from '@inflect/ui/components/ui/skeleton';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Textarea } from '@inflect/ui/components/ui/textarea';
import { Tooltip } from '@inflect/ui/components/ui/tooltip';
import { Heading } from '@inflect/ui/components/ui/typography';
import { ShieldCheck } from '@inflect/ui/components/ui/icons/nucleo/shield-check';
import { CloudUpload } from '@inflect/ui/components/ui/icons/nucleo/cloud-upload';
import { PreferencesBar } from '@/components/preferences-bar';

// A SHA-256 of the empty string: a realistic-looking 32-byte value for the demo.
const SAMPLE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card as="section" aria-labelledby={`${id}-heading`} className="flex flex-col gap-default" data-surface={id}>
      <Heading level={2} id={`${id}-heading`}>
        {title}
      </Heading>
      {children}
    </Card>
  );
}

export function KitchenSink() {
  const t = useTranslations('kitchenSink');
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-section px-default py-page">
      <header className="flex flex-col gap-default">
        <PreferencesBar />
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted">{t('intro')}</p>
      </header>

      <Section id="buttons" title={t('buttons')}>
        <div className="flex flex-wrap items-center gap-tight">
          <Button variant="primary" icon={<ShieldCheck />} data-testid="button-primary">
            {t('primary')}
          </Button>
          <Button variant="secondary">{t('secondary')}</Button>
          <Button variant="ghost">{t('ghost')}</Button>
          <Button variant="destructive" data-testid="button-destructive">
            {t('destructive')}
          </Button>
          <Button variant="primary" loading>
            {t('loading')}
          </Button>
        </div>
      </Section>

      <Section id="badges" title={t('statusBadges')}>
        <div className="flex flex-wrap items-center gap-tight">
          <StatusBadge variant="success" data-testid="badge-success">
            {t('badgeLatest')}
          </StatusBadge>
          <StatusBadge variant="info">{t('badgeSuperseded')}</StatusBadge>
          <StatusBadge variant="error">{t('badgeRevoked')}</StatusBadge>
          <StatusBadge variant="warning">{t('badgeAltered')}</StatusBadge>
          <StatusBadge variant="neutral">{t('badgeUnknown')}</StatusBadge>
        </div>
      </Section>

      <Section id="form" title={t('form')}>
        <FormField label={t('clientLabel')} hint={t('clientHint')} error={t('clientError')} required>
          <Input name="registrationNumber" data-testid="input-client" />
        </FormField>
        <FormField label={t('opinionLabel')} description={t('opinionDescription')}>
          <Textarea name="opinion" rows={3} />
        </FormField>
        <div className="flex items-center gap-tight">
          <code className="truncate font-mono text-sm text-content-muted">{SAMPLE_HASH}</code>
          <CopyButton value={SAMPLE_HASH} label={t('copyLabel')} />
        </div>
      </Section>

      <Section id="tooltip" title={t('tooltip')}>
        <div>
          <Tooltip content={t('tooltipContent')}>
            <Button variant="secondary">{t('tooltipTrigger')}</Button>
          </Tooltip>
        </div>
      </Section>

      <Section id="states" title={t('states')}>
        <EmptyState
          icon={CloudUpload}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          primaryAction={{ label: t('emptyAction'), onClick: () => undefined }}
          size="sm"
        />
        <ErrorState title={t('errorTitle')} description={t('errorDescription')} onRetry={() => undefined} />
        <SkeletonCard lines={2} />
      </Section>

      <Section id="overlays" title={t('overlays')}>
        <div className="flex flex-wrap items-center gap-tight">
          <Button variant="secondary" onClick={() => setModalOpen(true)} data-testid="open-modal">
            {t('openModal')}
          </Button>
          <Button variant="secondary" onClick={() => setConfirmOpen(true)}>
            {t('openConfirm')}
          </Button>
          <Button variant="secondary" onClick={() => setSheetOpen(true)}>
            {t('openSheet')}
          </Button>
        </div>
        <Modal showModal={modalOpen} setShowModal={setModalOpen} title={t('modalTitle')}>
          <Modal.Header title={t('modalTitle')} />
          <Modal.Body>
            <p className="text-content-default">{t('modalBody')}</p>
          </Modal.Body>
          <Modal.Actions>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              {t('ghost')}
            </Button>
            <Button variant="primary" onClick={() => setModalOpen(false)}>
              {t('primary')}
            </Button>
          </Modal.Actions>
        </Modal>
        <ConfirmDialog
          showModal={confirmOpen}
          setShowModal={setConfirmOpen}
          title={t('confirmTitle')}
          description={t('confirmBody')}
          tone="danger"
          confirmLabel={t('confirmAction')}
          onConfirm={() => setConfirmOpen(false)}
        />
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title={t('sheetTitle')}>
          <Sheet.Header title={t('sheetTitle')} />
          <Sheet.Body>
            <p className="text-content-default">{t('sheetBody')}</p>
          </Sheet.Body>
        </Sheet>
      </Section>
    </main>
  );
}
