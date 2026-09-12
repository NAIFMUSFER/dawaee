-- =============================================================================
-- Dawaee — 0035: disable caregiver channels that have no live provider
-- =============================================================================
--
-- The database enum intentionally retains SMS and WhatsApp so historical rows
-- stay readable and those providers can be activated later. The application
-- contract deliberately does not offer either channel today. Despite that,
-- every caregiver invitation used to create an enabled WhatsApp rule by
-- default. Production P20 evidence found three WhatsApp rules and all three
-- were enabled.
--
-- Preserve the rows as history, but make the operational truth explicit. A
-- future provider activation can re-enable them through a deliberate migration
-- together with the application contract/provider change.

UPDATE caregiver_notification_rules
   SET enabled = false
 WHERE channel IN ('sms'::notification_channel, 'whatsapp'::notification_channel)
   AND enabled = true;
