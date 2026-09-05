import { Redirect, useLocalSearchParams } from 'expo-router';
import React from 'react';

/**
 * The URL a caregiver invitation actually points at.
 *
 * The server has always built `${PUBLIC_APP_URL}/invite/<token>` — and nothing
 * served that path. The family member who received the invitation landed on
 * "Unmatched Route", so the care circle could not be formed at all, and every
 * escalation past the patient had nobody to reach.
 *
 * The accept screen already handles the token properly, including the case
 * where the recipient has no account yet, so this only has to carry the token
 * across to it.
 */
export default function InviteLink() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return <Redirect href={{ pathname: '/caregiver/accept', params: { token: token ?? '' } }} />;
}
