import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const { createHarness } = createRequire(import.meta.url)('./profile-screen-harness.cjs');

function invite() {
  return createHarness(resolve('apps/mobile/app/caregiver/invite.tsx'), resolve('apps/mobile/src/hooks/useRequestScope.ts'), { isSelf: true }, {
    'react-native': { Platform: { OS: 'web' }, View: 'View', Switch: 'Switch', Share: { share: async () => undefined } },
    'expo-sms': { isAvailableAsync: async () => false },
    'expo-clipboard': { setStringAsync: async () => undefined },
    '@/components/QrCode': { QrCode: 'QrCode' },
  });
}

describe('web invitation recipient matches mailbox registration', () => {
  it('requires a mailbox and does not create an unusable phone invitation on web', async () => {
    const h = invite();
    try {
      const recipient = h.find('Field', (p: any) => p.label === 'invite.email');
      expect(recipient).toBeTruthy();
      expect(recipient.hint).toBe('invite.webEmailHint');
      h.find('Field', (p: any) => p.label === 'invite.name').onChangeText('Synthetic caregiver');
      recipient.onChangeText('0500000001'); await h.flush();
      h.find('Button', (p: any) => p.testID === 'invite-send').onPress(); await h.flush();
      expect(h.requests).toHaveLength(0);
      expect(h.find('Field', (p: any) => p.label === 'invite.email').error).toBe('invite.emailRequired');
      expect(h.find('Button', (p: any) => p.label.includes('channel.sms'))).toBeNull();
    } finally { h.unmount(); }
  });
  it('creates a normalized email-bound invitation and shares its existing link without sending SMS', async () => {
    const h = invite();
    try {
      h.find('Field', (p: any) => p.label === 'invite.name').onChangeText('Synthetic caregiver');
      h.find('Field', (p: any) => p.label === 'invite.email').onChangeText(' Caregiver@Example.test ');
      await h.flush(); h.find('Button', (p: any) => p.testID === 'invite-send').onPress(); await h.flush();
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].payload).toMatchObject({ invitedEmail: 'caregiver@example.test', channel: 'link' });
      expect(h.requests[0].payload).not.toHaveProperty('invitedPhone');
      h.requests[0].resolve({ invitationLink: 'https://example.test/invite#synthetic', invitationMessage: 'Synthetic invitation' });
      await h.flush();
      expect(h.find('Button', (p: any) => p.label === 'invite.sendSms')).toBeNull();
      expect(h.text()).toContain('invite.emailNextSteps');
    } finally { h.unmount(); }
  });
});
