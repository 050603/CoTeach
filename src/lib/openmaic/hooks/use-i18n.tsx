'use client';

import { createContext, useContext, useEffect, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type Locale, defaultLocale, supportedLocales } from '@openmaic/lib/i18n';
import '@openmaic/lib/i18n/config';

const LOCALE_STORAGE_KEY = 'locale';

/** Match a browser language code (e.g. 'en', 'zh-TW') to a supported locale */
function resolveLocale(lang: string): Locale {
  // Exact match
  const exact = supportedLocales.find((l) => l.code === lang);
  if (exact) return exact.code;
  // Prefix match: 'en' → 'en-US', 'zh' → 'zh-CN'
  const prefix = lang.split('-')[0].toLowerCase();
  const match = supportedLocales.find((l) => l.code.toLowerCase().startsWith(prefix));
  return match?.code ?? defaultLocale;
}

type I18nContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({
  children,
  locale: fixedLocale,
}: {
  children: ReactNode;
  locale?: Locale;
}) {
  const { t, i18n } = useTranslation();

  const locale = fixedLocale ?? (i18n.language || defaultLocale) as Locale;

  // Detect language after hydration to avoid SSR mismatch.
  // i18next handles fallback automatically: if the detected language
  // has no matching JSON file, it falls back to fallbackLng.
  useEffect(() => {
    if (fixedLocale) {
      if (fixedLocale !== i18n.language) void i18n.changeLanguage(fixedLocale);
      return;
    }
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      const raw = stored || navigator.language || defaultLocale;
      const target = resolveLocale(raw);
      if (target !== i18n.language) i18n.changeLanguage(target);
    } catch {
      // localStorage unavailable, keep default
    }
  }, [fixedLocale]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLocale = (newLocale: Locale) => {
    if (fixedLocale) return;
    i18n.changeLanguage(newLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
    } catch {
      // localStorage unavailable
    }
  };

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
