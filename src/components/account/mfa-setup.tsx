'use client';

import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { CopyButton } from '@inflect/ui/components/ui/copy-button';
import { FormField } from '@inflect/ui/components/ui/form-field';
import { Input } from '@inflect/ui/components/ui/input';

type Setup = { secret: string; uri: string; qr: { size: number; path: string } };

async function post<T>(url: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; code: string }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  return response.ok ? { ok: true, data: json } : { ok: false, code: json.error ?? 'INTERNAL' };
}

/**
 * Scan a code, type the code the app shows, then keep the recovery codes,
 * which are shown once. Signing in again is what turns the session into one
 * verified with the second factor.
 */
export function MfaSetup() {
  const t = useTranslations('account.mfa');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    const result = await post<Setup>('/api/account/mfa/start');
    setBusy(false);
    if (result.ok) setSetup(result.data);
    else setError(result.code);
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await post<{ recoveryCodes: string[] }>('/api/account/mfa/confirm', { code: new FormData(event.currentTarget).get('code') });
    setBusy(false);
    if (result.ok) setCodes(result.data.recoveryCodes);
    else setError(result.code);
  }

  if (codes) {
    return (
      <div className="flex flex-col gap-default" data-testid="mfa-recovery-codes">
        <p role="status" className="text-content-success">
          {t('enabled')}
        </p>
        <p>{t('recoveryIntro')}</p>
        <ul className="grid grid-cols-2 gap-tight font-mono text-sm">
          {codes.map((code) => (
            <li key={code} data-testid="recovery-code">
              {code}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-tight">
          <CopyButton value={codes.join('\n')} label={t('copyCodes')} />
          <Button type="button" variant="primary" onClick={() => void signOut({ callbackUrl: '/login' })} data-testid="mfa-sign-in-again">
            {t('savedSignInAgain')}
          </Button>
        </div>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="flex flex-col gap-tight">
        <div>
          <Button type="button" variant="primary" loading={busy} onClick={() => void start()} data-testid="mfa-start">
            {t('start')}
          </Button>
        </div>
        {error ? <p role="alert" className="text-content-error">{t('error', { code: error })}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-default">
      <p>{t('scan')}</p>
      <svg viewBox={`0 0 ${setup.qr.size} ${setup.qr.size}`} className="h-56 w-56 bg-white" role="img" aria-label={t('qrLabel')} shapeRendering="crispEdges">
        <path d={setup.qr.path} fill="#000" />
      </svg>
      <div className="flex flex-col gap-tight">
        <span className="text-sm text-content-muted">{t('manual')}</span>
        <div className="flex items-center gap-tight">
          <code className="break-all font-mono text-sm" data-testid="mfa-secret">
            {setup.secret}
          </code>
          <CopyButton value={setup.secret} label={t('copySecret')} />
        </div>
      </div>
      <form onSubmit={confirm} className="flex flex-col gap-default">
        <FormField label={t('code')} required error={error ? t('error', { code: error }) : undefined}>
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required data-testid="mfa-code" />
        </FormField>
        <div>
          <Button type="submit" variant="primary" loading={busy} data-testid="mfa-confirm">
            {t('confirm')}
          </Button>
        </div>
      </form>
    </div>
  );
}
