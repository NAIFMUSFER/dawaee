-- Medication names stop appearing in notifications unless the patient asks.
--
-- Reminder bodies were built as "{medication} — {dose}. Scheduled {time}.", on
-- the phone and on the server, with no way to turn it off. That text reaches
-- the lock screen, Android's 24-hour notification history, the operating
-- system's scheduled-notification store, the notification_queue rows below and
-- the push provider — so a phone lying face-up on a desk told anyone walking
-- past which drug its owner takes, and for a large class of medicines the drug
-- names the diagnosis.
--
-- The column is the policy: FALSE means every notification says only that a
-- dose is due. TRUE is the patient's explicit, informed choice to trade that
-- privacy for the convenience of a named reminder, which for someone managing
-- eight medications is a real convenience and not a small one.
--
-- Default false, and no backfill, so this is a one-way narrowing: every
-- existing account becomes LESS exposed at the moment this migration runs, and
-- none becomes more. That direction is deliberate. A migration that preserved
-- current behaviour by setting the flag true for existing rows would leave
-- every patient who has never heard of this setting disclosing by default,
-- which is the state being fixed.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS show_medication_in_notifications boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN user_preferences.show_medication_in_notifications IS
  'Patient opt-in to naming the medication and dose in notification text. '
  'Default false. Governs the local notification on the device, the worker''s '
  'push body, and what is written into notification_queue.';
