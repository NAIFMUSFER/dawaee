import React from 'react';
import { Redirect } from 'expo-router';

/**
 * Legacy compatibility tombstone.
 *
 * Medication ids are health-linked identifiers and must not be recovered from
 * browser-visible path parameters. Current navigation uses /medication/detail
 * plus the account/profile-bound in-memory handoff. A direct legacy URL fails
 * closed back to the medications tab instead of ingesting the path id.
 */
export default function LegacyMedicationDetailRoute() {
  return <Redirect href="/(tabs)/medications" />;
}
