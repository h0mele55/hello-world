'use client';

import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { FormField } from '@inflect/ui/components/ui/form-field';
import { Input } from '@inflect/ui/components/ui/input';

/** Must match MFA_CODE_REQUIRED in src/auth.ts, which this client file cannot import. */
const MFA_CODE_REQUIRED = 'MFA_CODE_REQUIRED';

/**
 * Email and password, then, for an approver or admin with two-step sign-in,
 * a code from the authenticator or a recovery code. A refusal never says
 * which part was wrong.
 */
export function LoginForm() {
  const t = useTranslations('login');
  const router = useRouter();
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const entered = credentials ?? { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') };
    setBusy(true);
    setFailed(false);
    const result = await signIn('credentials', { ...entered, ...(credentials ? { otp: form.get('otp') } : {}), redirect: false });
    setBusy(false);
    if (result?.ok) {
      router.push('/reports');
      router.refresh();
    } else if (result?.error === MFA_CODE_REQUIRED && !credentials) {
      setCredentials(entered);
    } else {
      setFailed(true);
    }
  }

  if (credentials) {
    return (
      <form onSubmit={submit} className="flex flex-col gap-default" data-testid="login-form" data-step="code">
        <p className="text-content-muted">{t('codeIntro')}</p>
        <FormField label={t('code')} required error={failed ? t('codeFailed') : undefined}>
          <Input name="otp" autoComplete="one-time-code" maxLength={32} required autoFocus data-testid="login-code" />
        </FormField>
        <div className="flex flex-wrap gap-tight">
          <Button type="submit" variant="primary" loading={busy}>
            {t('submit')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setCredentials(null);
              setFailed(false);
            }}
          >
            {t('back')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-default" data-testid="login-form" data-step="password">
      <FormField label={t('email')} required>
        <Input name="email" type="email" autoComplete="username" required />
      </FormField>
      <FormField label={t('password')} required error={failed ? t('failed') : undefined}>
        <Input name="password" type="password" autoComplete="current-password" required />
      </FormField>
      <Button type="submit" variant="primary" loading={busy}>
        {t('submit')}
      </Button>
    </form>
  );
}
