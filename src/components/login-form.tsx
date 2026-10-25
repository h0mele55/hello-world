'use client';

import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@inflect/ui/components/ui/button';
import { FormField } from '@inflect/ui/components/ui/form-field';
import { Input } from '@inflect/ui/components/ui/input';

export function LoginForm() {
  const t = useTranslations('login');
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setFailed(false);
    const result = await signIn('credentials', { email: form.get('email'), password: form.get('password'), redirect: false });
    setBusy(false);
    if (result?.ok) {
      router.push('/reports');
      router.refresh();
    } else {
      setFailed(true);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-default" data-testid="login-form">
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
