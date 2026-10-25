export const LOCALES = ['en', 'bg'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'light';
export const THEME_COOKIE = 'theme';

export function asLocale(value: string | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? '') ? (value as Locale) : DEFAULT_LOCALE;
}

export function asTheme(value: string | undefined): Theme {
  return (THEMES as readonly string[]).includes(value ?? '') ? (value as Theme) : DEFAULT_THEME;
}
