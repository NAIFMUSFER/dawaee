import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const { createHarness } = createRequire(import.meta.url)('./profile-screen-harness.cjs');

describe('caregiver invitation QR and explicit SMS sharing', () => {
  it('renders the returned link as QR and opens Messages with normalized phone; cancellation is not success', async () => {
    const send = vi.fn().mockResolvedValue({ result: 'cancelled' });
    const available = vi.fn().mockResolvedValue(true);
    const h = createHarness(resolve('apps/mobile/app/caregiver/invite.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), { isSelf: true }, {
      'expo-sms': { isAvailableAsync: available, sendSMSAsync: send },
      'expo-clipboard': { setStringAsync: async () => {} },
      '@/components/QrCode': { QrCode: 'QrCode' },
    });
    try {
      expect(h.requests[0].route).toBe('/v1/caregivers/delivery-options');
      h.requests[0].resolve({ smsAvailable: false }); await h.flush();
      h.find('Field', (p: any) => p.label === 'invite.name').onChangeText('Synthetic caregiver');
      h.find('Field', (p: any) => p.label === 'invite.phone').onChangeText('٠٥٠٠٠٠٠٠٠١');
      await h.flush();
      h.find('Button', (p: any) => p.label === 'invite.send').onPress(); await h.flush();
      expect(h.requests).toHaveLength(2);
      expect(h.requests[1].payload.invitedPhone).toBe('0500000001');
      const link = 'https://example.invalid/invite#SYNTHETIC';
      h.requests[1].resolve({ relationshipId: 'r', invitationLink: link, invitationMessage: `Invitation ${link}` });
      await h.flush();
      expect(h.find('QrCode').value).toBe(link);
      expect(send).not.toHaveBeenCalled();
      h.find('Button', (p: any) => p.label === 'invite.sendSms').onPress(); await h.flush();
      expect(send).toHaveBeenCalledWith(['+966500000001'], `Invitation ${link}`);
      expect(h.text()).not.toContain('invite.smsSent');
      send.mockResolvedValueOnce({ result: 'sent' });
      h.find('Button', (p: any) => p.label === 'invite.sendSms').onPress(); await h.flush();
      expect(h.text()).toContain('invite.smsSent');
      let finish!: (value: boolean) => void;
      available.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      h.find('Button', (p: any) => p.label === 'invite.sendSms').onPress(); await h.flush();
      h.switchProfile('B');
      finish(true); await h.flush();
      expect(send).toHaveBeenCalledTimes(2);
      expect(h.text()).not.toContain(link);
    } finally { h.unmount(); }
  });

  it.each(['accepted', 'failed', 'unknown', 'unavailable'])('shows automatic SMS outcome %s truthfully, retains QR, and blocks duplicate taps', async (status) => {
    const composer = vi.fn();
    const h = createHarness(resolve('apps/mobile/app/caregiver/invite.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), { isSelf: true }, {
      'expo-sms': { isAvailableAsync: async () => true, sendSMSAsync: composer },
      'expo-clipboard': { setStringAsync: async () => {} }, '@/components/QrCode': { QrCode: 'QrCode' },
    });
    try {
      h.requests[0].resolve({ smsAvailable: true }); await h.flush();
      expect(h.text()).toContain('invite.smsAutomaticHint');
      h.find('Field', (p: any) => p.label === 'invite.name').onChangeText('Synthetic caregiver');
      h.find('Field', (p: any) => p.label === 'invite.phone').onChangeText('0500000001');
      await h.flush();
      const submit = h.find('Button', (p: any) => p.label === 'invite.send').onPress;
      submit(); submit(); await h.flush();
      expect(h.requests).toHaveLength(2);
      expect(h.requests[1].payload.channel).toBe('sms');
      h.requests[1].resolve({
        relationshipId: 'r', invitationLink: 'https://example.invalid/invite#synthetic',
        invitationMessage: 'Synthetic invitation', delivery: { channel: 'sms', status },
      });
      await h.flush();
      expect(h.find('QrCode').value).toContain('#synthetic');
      const statusKey = { accepted: 'smsAccepted', failed: 'smsFailed', unknown: 'smsUnknown', unavailable: 'smsServiceUnavailable' }[status];
      expect(h.text()).toContain(`invite.${statusKey}`);
      expect(h.text().includes('invite.sendSms')).toBe(status !== 'accepted');
      expect(composer).not.toHaveBeenCalled();
    } finally { h.unmount(); }
  });

  it('preserves an explicit QR choice when the capability read finishes later', async () => {
    const h = createHarness(resolve('apps/mobile/app/caregiver/invite.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), { isSelf: true }, {
      'expo-sms': {}, 'expo-clipboard': {}, '@/components/QrCode': { QrCode: 'QrCode' },
    });
    try {
      h.find('Button', (p: any) => p.label === 'channel.qr').onPress(); await h.flush();
      h.requests[0].resolve({ smsAvailable: true }); await h.flush();
      expect(h.find('Button', (p: any) => p.label === '✓ channel.qr')).toBeTruthy();
      expect(h.text()).not.toContain('invite.smsAutomaticHint');
    } finally { h.unmount(); }
  });

  it('falls back for an older API and ignores the prior profile capability response', async () => {
    const h = createHarness(resolve('apps/mobile/app/caregiver/invite.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), { isSelf: true }, {
      'expo-sms': {}, 'expo-clipboard': {}, '@/components/QrCode': { QrCode: 'QrCode' },
    });
    try {
      h.switchProfile('B'); await h.flush();
      h.requests[0].resolve({ smsAvailable: true });
      h.requests[1].reject(new Error('Synthetic old API 404')); await h.flush();
      expect(h.text()).not.toContain('channel.sms');
      expect(h.text()).toContain('channel.qr');
      expect(h.text()).toContain('channel.link');
    } finally { h.unmount(); }
  });
});
