import { describe, expect, it } from 'vitest';
import { syncWebDocumentDirection, webDocumentAttributes } from '../src/i18n/web-document-direction.js';

describe('web document locale semantics', () => {
  it('maps Arabic and English to the correct document language and direction', () => {
    expect(webDocumentAttributes('ar')).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(webDocumentAttributes('en')).toEqual({ lang: 'en', dir: 'ltr' });
  });

  it('updates the live document root when the locale changes', () => {
    const fakeDocument = { documentElement: { lang: 'ar', dir: 'rtl' } };
    syncWebDocumentDirection('en', fakeDocument);
    expect(fakeDocument.documentElement).toEqual({ lang: 'en', dir: 'ltr' });
    syncWebDocumentDirection('ar', fakeDocument);
    expect(fakeDocument.documentElement).toEqual({ lang: 'ar', dir: 'rtl' });
  });

  it('is a no-op when no browser document exists', () => {
    expect(() => syncWebDocumentDirection('en', undefined)).not.toThrow();
  });
});
