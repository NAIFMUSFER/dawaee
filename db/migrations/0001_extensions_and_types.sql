-- =============================================================================
-- Dawaee — 0001: extensions, enum types, shared helpers
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy medication-name search
CREATE EXTENSION IF NOT EXISTS btree_gist; -- exclusion constraints

CREATE SCHEMA IF NOT EXISTS app;

-- --------------------------------------------------------------- enum types

CREATE TYPE medication_form AS ENUM (
  'tablet','capsule','syrup','drops','injection','cream','inhaler','patch',
  'suppository','powder','spray','other');

CREATE TYPE dose_unit AS ENUM (
  'tablet','capsule','ml','mg','g','drop','puff','patch','unit','application','sachet','spray');

CREATE TYPE strength_unit AS ENUM ('mg','mcg','g','ml','iu','percent','mg_per_ml','mcg_per_dose');

CREATE TYPE medication_status AS ENUM ('active','paused','completed','expired','archived');

CREATE TYPE food_instruction AS ENUM
  ('no_preference','before_food','with_food','after_food','empty_stomach');

CREATE TYPE schedule_rule_kind AS ENUM ('fixed_times','interval','days_of_week','cycle','as_needed');

CREATE TYPE dose_status AS ENUM (
  'upcoming','due','pending_confirmation','snoozed','taken','taken_late','skipped','missed','cancelled');

CREATE TYPE confirmation_method AS ENUM (
  'app','push_action','notification_action','voice','watch','widget','caregiver','auto_missed','system');

CREATE TYPE dose_event_type AS ENUM (
  'scheduled','notified','snoozed','taken','skipped','missed','undone','escalated','cancelled');

CREATE TYPE caregiver_relationship_status AS ENUM ('pending','active','revoked','declined','expired');

CREATE TYPE caregiver_role AS ENUM
  ('son','daughter','spouse','parent','sibling','nurse','caregiver','doctor','other');

CREATE TYPE notification_channel AS ENUM ('push','local','whatsapp','sms','email','in_app');

CREATE TYPE delivery_status AS ENUM
  ('queued','sending','sent','delivered','read','failed','skipped','expired');

CREATE TYPE notification_kind AS ENUM (
  'dose_reminder','dose_reminder_repeat','escalation','low_stock','refill_due','expiry_warning',
  'prescription_renewal','daily_summary','weekly_summary','caregiver_invitation','system');

CREATE TYPE caregiver_notify_mode AS ENUM (
  'every_dose','missed_only','consecutive_missed','daily_summary','weekly_summary','never');

CREATE TYPE consent_type AS ENUM (
  'terms_of_service','privacy_policy','whatsapp_notifications','sms_notifications',
  'caregiver_data_sharing','emergency_card_public','ocr_image_processing','analytics');

CREATE TYPE travel_policy AS ENUM ('keep_home_time','follow_local_time','ask');

CREATE TYPE actor_role AS ENUM ('patient','caregiver','system','admin');

CREATE TYPE stock_reason AS ENUM
  ('dose_taken','dose_undone','refill','manual_correction','initial','discard');

CREATE TYPE identity_source AS ENUM ('user','ocr_confirmed_by_user','barcode_confirmed_by_user');

CREATE TYPE measurement_type AS ENUM
  ('blood_pressure','blood_glucose','weight','temperature','heart_rate','spo2');

CREATE TYPE ocr_status AS ENUM ('none','pending','completed','failed');

-- ------------------------------------------------------------ shared helpers

-- Session-scoped identity. The API issues `SET LOCAL app.user_id = '<uuid>'`
-- inside every request transaction; RLS policies read it back through here.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- A caregiver permission list is validated against this set so a typo can
-- never silently grant nothing (or everything).
CREATE OR REPLACE FUNCTION app.valid_permissions(perms text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT perms <@ ARRAY[
    'view_medications','view_schedule','view_adherence','view_history','view_reports',
    'view_emergency_card','receive_notifications','edit_schedule','add_medication',
    'edit_medication','update_stock','confirm_dose','manage_caregivers']::text[]
$$;
