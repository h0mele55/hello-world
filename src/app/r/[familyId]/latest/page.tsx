import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { Hex } from 'viem';
import { Card } from '@inflect/ui/components/ui/card';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { PreferencesBar } from '@/components/preferences-bar';
import { RecordView } from '@/components/verify/record-view';
import { CannotVerify, openRegistryView, summariseRecord, type CannotVerifyReason, type RecordSummary } from '@/lib/verify-core';
import { verifierSetupFromEnv, type VerifierSetupResult } from '@/lib/verify-setup';

export const dynamic = 'force-dynamic';

const FAMILY_ID = /^0x[0-9a-fA-F]{64}$/;

type Lookup =
  | { status: 'INVALID_ID' }
  | { status: 'NOT_CONFIGURED'; reason: string }
  | { status: 'CANNOT_VERIFY'; reason: CannotVerifyReason }
  | { status: 'NOT_FOUND' }
  | { status: 'FOUND'; latest: RecordSummary; asOfBlock: number };

async function lookUp(familyId: string, setup: VerifierSetupResult): Promise<Lookup> {
  if (!FAMILY_ID.test(familyId)) return { status: 'INVALID_ID' };
  if (!setup.ok) return { status: 'NOT_CONFIGURED', reason: setup.reason };
  try {
    const view = await openRegistryView(setup.setup);
    const latest = await view.latestOf(familyId.toLowerCase() as Hex);
    if (!latest) return { status: 'NOT_FOUND' };
    return { status: 'FOUND', latest: await summariseRecord(view, latest), asOfBlock: Number(view.blockNumber) };
  } catch (error) {
    if (error instanceof CannotVerify) return { status: 'CANNOT_VERIFY', reason: error.reason };
    throw error;
  }
}

/**
 * Where any copy of a report leads: the latest version of its family, read
 * from the chain through the same two agreeing endpoints as the verifier.
 * The record only; the PDF is never served here.
 */
export default async function LatestVersionPage({ params }: { params: Promise<{ familyId: string }> }) {
  const { familyId } = await params;
  const t = await getTranslations();
  const setupResult = verifierSetupFromEnv();
  const setup = setupResult.ok ? setupResult.setup : null;
  const result = await lookUp(familyId, setupResult);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-section px-default py-page">
      <PreferencesBar />
      <Card className="flex flex-col gap-default" data-testid="latest-page" data-status={result.status}>
        <Heading level={1}>{t('latest.title')}</Heading>
        <code className="break-all font-mono text-sm text-content-muted">{familyId}</code>
        {result.status === 'INVALID_ID' ? <p>{t('latest.invalidId')}</p> : null}
        {result.status === 'NOT_CONFIGURED' ? <p>{t('verify.notConfigured')}</p> : null}
        {result.status === 'CANNOT_VERIFY' ? (
          <p>{t('verify.verdict.CANNOT_VERIFY.body', { reason: t(`verify.cannotVerify.${result.reason}`) })}</p>
        ) : null}
        {result.status === 'NOT_FOUND' ? <p>{t('latest.notFound')}</p> : null}
        {result.status === 'FOUND' && setup ? (
          <>
            <div>
              <StatusBadge variant={result.latest.revoked ? 'error' : 'success'} data-testid="latest-status">
                {result.latest.revoked ? t('latest.revoked', { code: result.latest.revokeReason }) : t('latest.current')}
              </StatusBadge>
            </div>
            <RecordView title={t('verify.details.latest')} record={result.latest} chainId={setup.chainId} issuers={setup.issuers} testId="record-latest" />
            <p className="text-sm text-content-muted">{t('verify.details.asOf', { block: result.asOfBlock })}</p>
          </>
        ) : null}
        <p className="text-sm text-content-muted">{t('latest.noPdf')}</p>
        <div>
          <Link href="/verify" className="text-content-info hover:underline" data-testid="verify-link">
            {t('latest.verifyLink')}
          </Link>
        </div>
        <p className="text-sm text-content-muted">{t('verify.disclaimer')}</p>
      </Card>
    </main>
  );
}
