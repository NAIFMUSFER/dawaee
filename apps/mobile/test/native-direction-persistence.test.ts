import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as messages from '@dawaee/shared';
import type { Locale } from '@dawaee/shared';

const file = fileURLToPath(new URL('../src/i18n/index.tsx', import.meta.url));
const source = ts.transpileModule(readFileSync(file, 'utf8'), {
  fileName: file,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  },
}).outputText;

/** Execute the real helper, retaining RN's process-constant isRTL while its
 * native setters persist values for the next start. Not a device/UI test. */
function runtime(os: string, currentRtl: boolean) {
  const stored = { allow: currentRtl, force: currentRtl };
  const native = {
    isRTL: currentRtl,
    allowRTL: vi.fn((allow: boolean) => { stored.allow = allow; }),
    forceRTL: vi.fn((force: boolean) => { stored.force = force; }),
  };
  const mocks: Record<string, unknown> = {
    react: { createContext: () => ({}) },
    'react/jsx-runtime': {},
    'react-native': { I18nManager: native, Platform: { OS: os } },
    '@dawaee/shared': messages,
    './web-document-direction.js': { syncWebDocumentDirection: vi.fn() },
  };
  const module = { exports: {} };
  runInNewContext(source, {
    module, exports: module.exports,
    require: (name: string) => {
      if (!(name in mocks)) throw new Error(`Unexpected test dependency: ${name}`);
      return mocks[name];
    },
  }, { filename: file });
  const { applyNativeDirection } = module.exports as {
    applyNativeDirection: (locale: Locale) => { restartRequired: boolean };
  };
  return { applyNativeDirection, stored, native };
}

for (const os of ['ios', 'android']) {
  for (const currentRtl of [false, true]) {
    const current: Locale = currentRtl ? 'ar' : 'en';
    const other: Locale = currentRtl ? 'en' : 'ar';
    describe(`${os}, running ${current}`, () => {
      it('persists the other direction without pretending the current runtime changed', () => {
        const h = runtime(os, currentRtl);
        expect(h.applyNativeDirection(other)).toEqual({ restartRequired: true });
        expect(h.native.isRTL).toBe(currentRtl);
        expect(h.stored).toEqual({ allow: !currentRtl, force: !currentRtl });
      });

      it('cancels a pending opposite direction when the user switches back before restart', () => {
        const h = runtime(os, currentRtl);
        h.applyNativeDirection(other);
        expect(h.applyNativeDirection(current)).toEqual({ restartRequired: false });
        expect(h.stored).toEqual({ allow: currentRtl, force: currentRtl });
        // Simulate next-start policy on either device language. The final
        // in-app choice, not the previously abandoned choice, must win.
        for (const deviceRtl of [false, true]) {
          expect(h.stored.force || (h.stored.allow && deviceRtl)).toBe(currentRtl);
        }
      });

      it('always persists the final choice across repeated toggles and matching bootstraps', () => {
        const h = runtime(os, currentRtl);
        for (const locale of [other, current, current, other, current]) {
          expect(h.applyNativeDirection(locale).restartRequired).toBe(locale !== current);
          expect(h.stored).toEqual({ allow: locale === 'ar', force: locale === 'ar' });
        }
      });
    });
  }
}

describe('web stays independent from native direction persistence', () => {
  it.each([false, true])('does not call native setters when isRTL is %s', currentRtl => {
    const h = runtime('web', currentRtl);
    for (const locale of ['ar', 'en'] as const) {
      expect(h.applyNativeDirection(locale)).toEqual({ restartRequired: false });
    }
    expect(h.native.allowRTL).not.toHaveBeenCalled();
    expect(h.native.forceRTL).not.toHaveBeenCalled();
    expect(h.stored).toEqual({ allow: currentRtl, force: currentRtl });
  });
});
