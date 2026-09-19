import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createHarness } = require('./profile-screen-harness.cjs');
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => { for (const h of mounted.splice(0)) h.unmount(); });

// Executes the shipped component with controlled hooks and host elements.
// This guards action/privacy semantics, not browser or physical-device acceptance.
function harness(platform = 'web') {
  const original = vi.fn();
  const alert = { alert: original };
  const props = { scope: 'account-A:patient-A' };
  const state = { pathname: '/caregiver/detail', contentBlocked: false };
  const nativeConfirm = vi.fn(() => { throw new Error('blocking browser dialog must not open'); });
  const h = createHarness(resolve('apps/mobile/src/components/WebAlertHost.tsx'), undefined, {}, {
    __props: props,
    __globals: { confirm: nativeConfirm },
    'react-native': { Alert: alert, Platform: { OS: platform }, View: 'View', ScrollView: 'ScrollView' },
    'expo-router': { usePathname: () => state.pathname },
    '@/security/AppLockContext': { useAppLock: () => ({ contentBlocked: state.contentBlocked }) },
    '@/hooks/useTheme': { useTheme: () => ({ colors: {}, spacing: {}, radius: {} }) },
  });
  mounted.push(h);
  return { h, alert, original, props, state, nativeConfirm,
    button: (label: string) => h.find('Button', (p: { label: string }) => p.label === label) };
}

describe('web care-circle confirmation', () => {
  it('shows the actual labels, waits for explicit consent, and honours Cancel', async () => {
    const { h, alert, button, nativeConfirm } = harness();
    const cancel = vi.fn(), revoke = vi.fn();
    alert.alert('إلغاء الوصول', 'اختبار ممرض فقط', [
      { text: 'إلغاء', style: 'cancel', onPress: cancel },
      { text: 'إلغاء الوصول', style: 'destructive', onPress: revoke },
    ]);
    await h.flush();
    expect(h.text()).toContain('اختبار ممرض فقط');
    expect(button('إلغاء الوصول').tone).toBe('danger');
    expect(revoke).not.toHaveBeenCalled();
    button('إلغاء').onPress(); await h.flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(h.tree).toBeNull();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('runs the selected destructive callback once even if the same event is delivered twice', async () => {
    const { h, alert, button } = harness();
    const revoke = vi.fn();
    alert.alert('Confirm', '', [{ text: 'Revoke', style: 'destructive', onPress: revoke }]);
    await h.flush();
    const click = button('Revoke').onPress;
    click(); click(); await h.flush();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(h.tree).toBeNull();
  });

  it('keeps multiple actions distinct instead of always choosing the destructive one', async () => {
    const { h, alert, button } = harness();
    const keep = vi.fn(), revoke = vi.fn();
    alert.alert('Choice', '', [{ text: 'Cancel', style: 'cancel' },
      { text: 'Keep', onPress: keep }, { text: 'Revoke', style: 'destructive', onPress: revoke }]);
    await h.flush(); button('Keep').onPress(); await h.flush();
    expect(keep).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('dismisses through the cancellation action, never the destructive action', async () => {
    const { h, alert } = harness();
    const cancel = vi.fn(), revoke = vi.fn();
    alert.alert('Confirm', '', [{ text: 'Cancel', style: 'cancel', onPress: cancel },
      { text: 'Revoke', style: 'destructive', onPress: revoke }]);
    await h.flush(); h.find('Modal').onRequestClose(); await h.flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(h.tree).toBeNull();
  });

  it('respects a non-cancelable dialog while leaving explicit buttons usable', async () => {
    const { h, alert, button } = harness();
    const callback = vi.fn();
    alert.alert('Confirm', '', [{ text: 'Continue', onPress: callback }], { cancelable: false });
    await h.flush(); h.find('Modal').onRequestClose(); await h.flush();
    expect(button('Continue')).not.toBeNull();
    expect(callback).not.toHaveBeenCalled();
    button('Continue').onPress();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('provides a translated acknowledgement for informational alerts', async () => {
    const { h, alert, button } = harness();
    alert.alert('Could not save action'); await h.flush();
    expect(button('common.ok')).not.toBeNull();
    button('common.ok').onPress(); await h.flush();
    expect(h.tree).toBeNull();
  });

  it('invalidates callbacks when a newer alert replaces the previous one', async () => {
    const { h, alert, button } = harness();
    const old = vi.fn(), fresh = vi.fn();
    alert.alert('Old', '', [{ text: 'Old action', onPress: old }]); await h.flush();
    const staleClick = button('Old action').onPress;
    alert.alert('New', '', [{ text: 'New action', onPress: fresh }]); await h.flush();
    staleClick();
    expect(old).not.toHaveBeenCalled();
    button('New action').onPress();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it.each(['account', 'patient', 'route'])('discards pending actions on a %s change', async change => {
    const { h, alert, button, props, state } = harness();
    const revoke = vi.fn();
    alert.alert('Private previous patient', '', [{ text: 'Revoke', onPress: revoke }]); await h.flush();
    const staleClick = button('Revoke').onPress;
    if (change === 'account') props.scope = 'account-B:patient-A';
    if (change === 'patient') props.scope = 'account-A:patient-B';
    if (change === 'route') state.pathname = '/today';
    h.render(); await h.flush(); staleClick();
    expect(h.tree).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    alert.alert('Current scope'); await h.flush();
    expect(h.text()).toContain('Current scope');
    expect(h.text()).not.toContain('Private previous patient');
  });

  it('drops the confirmation when app lock covers content and does not restore it on unlock', async () => {
    const { h, alert, button, state } = harness();
    const revoke = vi.fn();
    alert.alert('Private patient', '', [{ text: 'Revoke', onPress: revoke }]); await h.flush();
    const staleClick = button('Revoke').onPress;
    state.contentBlocked = true; h.render(false); staleClick();
    expect(revoke).not.toHaveBeenCalled();
    expect(h.tree).toBeNull();
    await h.flush();
    alert.alert('Must not appear while locked'); await h.flush();
    state.contentBlocked = false; h.render(); await h.flush();
    expect(h.tree).toBeNull();
  });

  it('restores the original adapter on unmount and invalidates retained callbacks', async () => {
    const { h, alert, original, button } = harness();
    const revoke = vi.fn();
    alert.alert('Private', '', [{ text: 'Revoke', onPress: revoke }]); await h.flush();
    const click = button('Revoke').onPress;
    h.unmount(); click();
    expect(alert.alert).toBe(original);
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'])('leaves the native %s alert implementation untouched', platform => {
    const { h, alert, original } = harness(platform);
    expect(alert.alert).toBe(original);
    expect(h.tree).toBeNull();
  });

  it('mounts the host within app lock with the actual account/profile scope', () => {
    const layout = readFileSync(resolve('apps/mobile/app/_layout.tsx'), 'utf8');
    const start = layout.indexOf('<AppLockGate>'), end = layout.indexOf('</AppLockGate>');
    expect(layout.slice(start, end)).toContain('<WebAlertHost scope={clinicalRouteScope} />');
    expect(layout).not.toContain('globalThis.confirm');
  });
});
