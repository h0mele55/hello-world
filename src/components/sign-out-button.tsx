'use client';

import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Button } from '@inflect/ui/components/ui/button';

export function SignOutButton() {
  const t = useTranslations('nav');
  return (
    <Button type="button" variant="ghost" onClick={() => signOut({ callbackUrl: '/login' })}>
      {t('signOut')}
    </Button>
  );
}
