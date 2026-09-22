import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const { createHarness } = createRequire(import.meta.url)('./profile-screen-harness.cjs');
const make = (imageKey: string | null = 'photo-a') => createHarness(
  resolve('apps/mobile/src/components/MedicationPhoto.tsx'),
  resolve('apps/mobile/src/hooks/useRequestScope.ts'), {},
  { __exportName: 'MedicationPhoto', __props: { imageKey, name: 'Synthetic medication', prominent: true } },
);

describe('private medication photo', () => {
  it('loads the private photo at a readable size without cropping', async () => {
    const h = make();
    try {
      h.render(); h.requests[0].resolve({ url: 'https://synthetic.invalid/photo-a' }); await h.flush();
      expect(h.find('Image').source.uri).toBe('https://synthetic.invalid/photo-a');
      expect(h.find('Image').resizeMode).toBe('contain');
      expect(h.find('Image').style.height).toBe(200);
      h.find('Image').onError(); await h.flush();
      expect(h.find('Image')).toBeNull();
    } finally { h.unmount(); }
  });
  it('removes the previous patient photo immediately, before effects run', async () => {
    const h = make();
    try {
      h.render(); h.requests[0].resolve({ url: 'https://synthetic.invalid/patient-a' }); await h.flush();
      h.switchProfile('B', false);
      expect(h.find('Image')).toBeNull();
      await h.flush(); h.requests[1].resolve({ url: 'https://synthetic.invalid/patient-b' }); await h.flush();
      expect(h.find('Image').source.uri).toBe('https://synthetic.invalid/patient-b');
    } finally { h.unmount(); }
  });
  it('ignores a late previous-account response and handles denied access', async () => {
    const h = make();
    try {
      h.render(); h.app.user = { id: 'new-account' }; h.render();
      h.requests[1].reject(new Error('access denied')); await h.flush();
      h.requests[0].resolve({ url: 'https://synthetic.invalid/old-account' }); await h.flush();
      expect(h.find('Image')).toBeNull();
    } finally { h.unmount(); }
  });
  it('does not request a missing photo', () => {
    const h = make(null);
    try { h.render(); expect(h.requests).toHaveLength(0); expect(h.find('Image')).toBeNull(); }
    finally { h.unmount(); }
  });
});
