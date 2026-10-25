'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { THEME_COOKIE, type Theme } from '@/lib/preferences';

const ONE_YEAR = 60 * 60 * 24 * 365;

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);

/**
 * Holds the colour theme. The server reads the cookie and renders
 * <html data-theme> itself, so the first paint is already right; this keeps
 * the attribute and the cookie in step when the user switches.
 */
export function ThemeProvider({ initialTheme, children }: { initialTheme: Theme; children: ReactNode }) {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
