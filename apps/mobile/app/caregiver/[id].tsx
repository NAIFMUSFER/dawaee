import React from 'react';
import { Redirect } from 'expo-router';

/**
 * Legacy compatibility tombstone.
 *
 * Relationship ids are health-linked identifiers and must not be recovered
 * from browser-visible path parameters. Current navigation uses the fixed
 * /caregiver/detail route plus the account/profile-bound in-memory handoff.
 * A direct legacy URL therefore fails closed back to the care-circle screen.
 */
export default function LegacyCaregiverDetailRoute() {
  return <Redirect href="/(tabs)/family" />;
}
