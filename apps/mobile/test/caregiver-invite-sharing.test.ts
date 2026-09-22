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
      h.find('Field', (p: any) => p.label === 'invite.name').onChangeText('Synthetic caregiver');
      h.find('Field', (p: any) => p.label === 'invite.recipient').onChangeText('٠٥٠٠٠٠٠٠٠١');
      await h.flush();
      h.find('Button', (p: any) => p.label === 'invite.send').onPress(); await h.flush();
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].payload.invitedPhone).toBe('0500000001');
      const link = 'https://example.invalid/invite#SYNTHETIC';
      h.requests[0].resolve({ relationshipId: 'r', invitationLink: link, invitationMessage: `Invitation ${link}` });
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
});
