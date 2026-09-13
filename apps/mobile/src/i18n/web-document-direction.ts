import { isRtl, type Locale } from '@dawaee/shared';

export interface WebDocumentLike {
  documentElement: {
    lang: string;
    dir: string;
  };
}

export function webDocumentAttributes(locale: Locale): { lang: 'ar' | 'en'; dir: 'rtl' | 'ltr' } {
  return {
    lang: locale === 'ar' ? 'ar' : 'en',
    dir: isRtl(locale) ? 'rtl' : 'ltr',
  };
}

/**
 * Keep the browser document semantics aligned with the rendered locale.
 *
 * The inlined Expo shell starts in Arabic because the language picker is the
 * first screen. After a user chooses English, however, the browser document
 * must also switch to lang=en/dir=ltr; otherwise assistive technology keeps
 * treating an English screen as Arabic/RTL even though React renders English.
 * Native runtimes have no document and this is deliberately a no-op there.
 */
export function syncWebDocumentDirection(
  locale: Locale,
  target: WebDocumentLike | undefined = (globalThis as { document?: WebDocumentLike }).document,
): void {
  if (!target) return;
  const next = webDocumentAttributes(locale);
  target.documentElement.lang = next.lang;
  target.documentElement.dir = next.dir;
}
