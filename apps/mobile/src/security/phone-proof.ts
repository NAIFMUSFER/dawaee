export interface PhoneChallenge {
  confirm: (code: string) => Promise<void>;
  cancel: () => void;
}

// Web/iOS verification needs a separately registered Firebase application.
// An already verified account can accept invitations on every platform.
export const phoneVerificationSupported = false;
export async function startPhoneProof(
  _phone: string, _onProof: (idToken: string) => Promise<void>, _onError?: (error: unknown) => void,
): Promise<PhoneChallenge> {
  throw new Error('Phone verification requires the configured Android app');
}
