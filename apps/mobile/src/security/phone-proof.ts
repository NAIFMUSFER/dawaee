export interface PhoneChallenge {
  confirm: (code: string) => Promise<void>;
  cancel: () => void;
}

// Web verification needs a separately configured Firebase application.
// An already verified account can accept invitations on every platform.
export const phoneVerificationSupported = false;
export async function startPhoneProof(
  _phone: string, _onProof: (idToken: string) => Promise<void>, _onError?: (error: unknown) => void,
): Promise<PhoneChallenge> {
  throw new Error('Phone verification requires the configured mobile app');
}
