'use server';

import { cookies } from 'next/headers';
import { LOCALE_COOKIE, asLocale } from '@/lib/preferences';

/** Stores the chosen language. Anything but a known locale falls back to English. */
export async function setLocale(locale: string) {
  (await cookies()).set(LOCALE_COOKIE, asLocale(locale), {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
}
