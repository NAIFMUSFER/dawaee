export interface EmailIdentity {
  emailVerified?: boolean;
  emailVerificationRequired?: boolean;
}

export function needsEmailVerification(signedIn: boolean, user: EmailIdentity | null): boolean {
  return signedIn && (user?.emailVerificationRequired === true || user?.emailVerified === false);
}
