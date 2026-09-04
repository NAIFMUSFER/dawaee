-- A password registration must produce the same account an OTP sign-in does.
--
-- `app.find_or_create_user_by_phone` (0011) inserts three rows for a new
-- account: the user, their preferences, and the self patient profile. The
-- password path added in 0015 inserted only the user. Nothing failed and
-- nothing was logged — the account simply had no profile, so every screen that
-- needs one sat on a loading spinner forever and the person who had just
-- signed up could never reach their own medication list.
--
-- This makes the two paths agree, and returns the profile id so the API can
-- use it directly rather than fetching it back.
--
-- Idempotent by construction: the inserts run only on the branch that has just
-- created the user, and the profile insert is guarded for the case where a
-- self profile somehow already exists.

-- The OUT columns change, and CREATE OR REPLACE cannot alter a function's row
-- type. Dropping first is safe: the grant is re-issued below, and nothing else
-- depends on this function.
DROP FUNCTION IF EXISTS app.register_with_password(text, text, text, text, text);

CREATE FUNCTION app.register_with_password(
  p_phone text, p_email text, p_display_name text, p_password_hash text, p_locale text
) RETURNS TABLE (user_id uuid, created boolean, self_profile_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
#variable_conflict use_column
DECLARE
  existing uuid;
  new_id uuid;
  profile uuid;
  loc text := coalesce(p_locale, 'ar');
BEGIN
  SELECT u.id INTO existing FROM users u
   WHERE (p_phone IS NOT NULL AND u.phone_e164 = p_phone)
      OR (p_email IS NOT NULL AND lower(u.email) = lower(p_email))
   LIMIT 1;

  IF existing IS NOT NULL THEN
    RETURN QUERY SELECT existing, false, NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO users (phone_e164, email, display_name, locale)
  VALUES (p_phone, p_email, p_display_name, loc)
  RETURNING id INTO new_id;

  IF p_password_hash IS NOT NULL THEN
    INSERT INTO user_credentials (user_id, password_hash) VALUES (new_id, p_password_hash);
  END IF;

  INSERT INTO user_preferences (user_id, locale) VALUES (new_id, loc)
  ON CONFLICT (user_id) DO NOTHING;

  -- The account holder is a patient of their own account until they say
  -- otherwise. Without this row there is nothing for a medication to belong to.
  SELECT id INTO profile FROM patient_profiles
   WHERE owner_user_id = new_id AND is_self AND archived_at IS NULL LIMIT 1;

  IF profile IS NULL THEN
    INSERT INTO patient_profiles (owner_user_id, linked_user_id, display_name, is_self)
    VALUES (new_id, new_id, p_display_name, true)
    RETURNING id INTO profile;
  END IF;

  RETURN QUERY SELECT new_id, true, profile;
END $$;

-- The return type changed, so the old signature's grant does not carry over.
REVOKE ALL ON FUNCTION app.register_with_password(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_with_password(text, text, text, text, text) TO dawaee_app;

-- Accounts already created by the incomplete function. Registration was only
-- ever reachable in this window, so this is a small, bounded repair rather
-- than a general backfill: every user holding credentials but no profile of
-- their own gets the two rows they should have had at sign-up.
INSERT INTO user_preferences (user_id, locale)
SELECT u.id, u.locale FROM users u
  JOIN user_credentials c ON c.user_id = u.id
 WHERE NOT EXISTS (SELECT 1 FROM user_preferences p WHERE p.user_id = u.id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO patient_profiles (owner_user_id, linked_user_id, display_name, is_self)
SELECT u.id, u.id, u.display_name, true FROM users u
  JOIN user_credentials c ON c.user_id = u.id
 WHERE u.display_name IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM patient_profiles p
      WHERE p.owner_user_id = u.id AND p.is_self AND p.archived_at IS NULL);
