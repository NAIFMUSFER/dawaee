import { describe, expect, it } from 'vitest';
import path from 'node:path';
const { createHarness } = require('./profile-screen-harness.cjs');

describe('time picker action semantics (not native gesture proof)', () => {
  it('exposes every minute and preserves committed time across cancel/back/reopen', async () => {
    const writes: string[] = [];
    let keyboardDismissals = 0;
    const hosts = new Proxy({}, { get: (_t, k) => k === '__esModule' ? true : k });
    const h = createHarness(path.resolve('apps/mobile/src/components/TimeField.tsx'), undefined, {}, {
      __exportName: 'TimeField', __props: { label: 'Appointment', value: '19:47', onChange: (v: string) => writes.push(v) },
      'react-native': { Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View', Keyboard: { dismiss: () => keyboardDismissals++ } },
      './ui.js': hosts,
      '../hooks/useTheme.js': { useTheme: () => ({ touch: 56, colors: {}, spacing: { md: 16, sm: 8, xs: 4 }, radius: { md: 8 } }) },
      '../i18n/index.js': { useI18n: () => ({ t: (v: string) => v, locale: 'en' }) },
    });
    try {
      const open = async () => { h.find('Pressable', (p: any) => p.accessibilityLabel === 'Appointment: 19:47').onPress(); await h.flush(); };
      await open();
      expect(keyboardDismissals).toBe(1);
      expect(h.text()).toContain('19'); expect(h.text()).toContain('47');
      for (let i = 0; i < 60; i++) expect(h.find('Pressable', (p: any) => p.accessibilityLabel === `Minutes: ${String(i).padStart(2, '0')}`)).toBeTruthy();
      h.find('Pressable', (p: any) => p.accessibilityLabel === 'Minutes: 59').onPress(); await h.flush();
      h.find('Modal').onRequestClose(); await h.flush();
      expect(writes).toEqual([]);
      await open();
      expect(h.find('Pressable', (p: any) => p.accessibilityLabel === 'Minutes: 47').accessibilityState.selected).toBe(true);
      h.find('Pressable', (p: any) => p.accessibilityLabel === 'Minutes: 59').onPress(); await h.flush();
      h.find('Button', (p: any) => p.label === 'common.done').onPress(); await h.flush();
      expect(writes).toEqual(['19:59']);
      expect(h.find('Modal').visible).toBe(false);
      await open(); h.find('Button', (p: any) => p.label === 'common.cancel').onPress(); await h.flush();
      expect(writes).toEqual(['19:59']);
    } finally { h.unmount(); }
  });
});
