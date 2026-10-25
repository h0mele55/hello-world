import { getFormatter, getTranslations } from 'next-intl/server';
import { formatEther } from 'viem';
import { Card } from '@inflect/ui/components/ui/card';
import { CopyButton } from '@inflect/ui/components/ui/copy-button';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { ChainModeForm } from '@/components/reports/chain-mode-form';
import { getChainWriteMode } from '@/lib/anchoring/approve';
import { MODE_LADDER } from '@/lib/anchoring/ladder';
import { getIssuerKeyStatus, resolveAnchorTarget } from '@/lib/anchoring/queries';
import { explorerAddressUrl } from '@/lib/chain/explorer';
import { requireUser } from '@/lib/page-auth';
import { mayDo } from '@/lib/roles';

function Address({ label, value, href }: { label: string; value: string; href: string | null }) {
  return (
    <div className="flex flex-col gap-tight">
      <span className="text-sm text-content-muted">{label}</span>
      <div className="flex items-center gap-tight">
        <code className="break-all font-mono text-sm">{value}</code>
        <CopyButton value={value} label={label} />
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="text-sm text-content-info hover:underline">
            ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}

export default async function SettingsPage() {
  const user = await requireUser();
  const t = await getTranslations('settings');
  const format = await getFormatter();
  const mode = await getChainWriteMode(user);
  const { target, problem } = resolveAnchorTarget();
  const key = await getIssuerKeyStatus(target);

  return (
    <main className="flex flex-col gap-section">
      <Heading level={1}>{t('title')}</Heading>
      <Card className="flex flex-col gap-default">
        <Heading level={2}>{t('modeTitle')}</Heading>
        <p className="text-content-muted">{t('modeIntro')}</p>
        <ul className="flex flex-col gap-tight">
          {MODE_LADDER.map((m) => (
            <li key={m}>
              <strong>{t(`modes.${m}`)}</strong>: <span className="text-content-muted">{t(`modeDescriptions.${m}`)}</span>
            </li>
          ))}
        </ul>
        <p>
          {t('currentMode')}{' '}
          <StatusBadge variant={mode === 'LIVE' ? 'success' : mode === 'DRY_RUN' ? 'info' : 'neutral'} data-testid="current-mode" data-mode={mode}>
            {t(`modes.${mode}`)}
          </StatusBadge>
        </p>
        {mayDo(user.role, 'setChainMode') ? <ChainModeForm current={mode} /> : <p className="text-content-muted">{t('approverOnly')}</p>}
      </Card>
      <Card className="flex flex-col gap-default">
        <Heading level={2}>{t('chainTitle')}</Heading>
        {target ? (
          <>
            <p>
              <span className="text-content-muted">{t('network')}: </span>
              {target.network} ({t('chainId')} {target.chainId})
            </p>
            <Address label={t('registry')} value={target.registry} href={explorerAddressUrl(target.chainId, target.registry)} />
            <Address label={t('issuer')} value={target.issuer} href={explorerAddressUrl(target.chainId, target.issuer)} />
            {key ? (
              <p data-testid="issuer-balance" data-low={key.low}>
                <span className="text-content-muted">{t('balance')}: </span>
                <span className={key.low ? 'text-content-error' : undefined}>{formatEther(BigInt(key.balanceWei))} ETH</span>{' '}
                <span className="text-sm text-content-muted">{t('checkedAt', { at: format.dateTime(key.checkedAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</span>
              </p>
            ) : (
              <p className="text-content-muted">{t('balanceUnknown')}</p>
            )}
          </>
        ) : (
          <p className="text-content-warning">
            {t('notConfigured')} <span className="text-content-muted">({problem})</span>
          </p>
        )}
      </Card>
    </main>
  );
}
