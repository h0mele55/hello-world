import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { PreferencesBar } from '@/components/preferences-bar';
import { VerifyClient } from '@/components/verify/verify-client';
import { explorerAddressUrl, networkNameOf } from '@/lib/chain/explorer';
import { standaloneVerifierUrlOf, verifierSetupFromEnv } from '@/lib/verify-setup';

export const dynamic = 'force-dynamic';

/**
 * Public, no sign-in: anyone checks a report here. The server only hands the
 * page the registry's address and two public RPC endpoints; the check itself
 * runs in the visitor's browser and never uploads the file (rule 5). When the
 * firm publishes the single-file verifier (#85), the page links it, so a
 * visitor can check without this site.
 */
export default async function VerifyPage() {
  const t = await getTranslations('verify');
  const result = verifierSetupFromEnv();
  const standaloneUrl = standaloneVerifierUrlOf();
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-section px-default py-page">
      <PreferencesBar />
      <div className="flex flex-col gap-default">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted">{t('intro')}</p>
        <div>
          <StatusBadge variant="warning">{t('disclaimer')}</StatusBadge>
        </div>
      </div>
      {result.ok ? (
        <>
          <VerifyClient setup={result.setup} />
          <p className="text-sm text-content-muted" data-testid="verify-registry">
            {t('checksAgainst', { contract: result.setup.registry, network: networkNameOf(result.setup.chainId) })}{' '}
            {explorerAddressUrl(result.setup.chainId, result.setup.registry) ? (
              <a href={explorerAddressUrl(result.setup.chainId, result.setup.registry)!} target="_blank" rel="noreferrer" className="text-content-info hover:underline">
                ↗
              </a>
            ) : null}
          </p>
        </>
      ) : (
        <Card className="flex flex-col gap-tight" data-testid="verify-not-configured">
          <p className="text-content-default">{t('notConfigured')}</p>
          <p className="text-sm text-content-muted">{t(`setupRefusal.${result.reason}`)}</p>
        </Card>
      )}
      {standaloneUrl && standaloneUrl !== 'INVALID' ? (
        <p className="text-sm text-content-muted" data-testid="verify-standalone">
          {t('standalone.text')}{' '}
          <a href={standaloneUrl} target="_blank" rel="noreferrer" className="text-content-info hover:underline">
            {t('standalone.link')}
          </a>
        </p>
      ) : null}
    </main>
  );
}
