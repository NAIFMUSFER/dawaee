-- =============================================================================
-- Dawaee — 0046: push-token ownership follows the physical installation
-- =============================================================================
--
-- PROVEN DEFECT (red regression: push-token-account-switch.test.ts)
--
-- Mobile sign-out is deliberately local-first: if the phone is offline, the
-- best-effort DELETE /v1/devices/push-token never reaches the API. The previous
-- account therefore keeps an active row for this installation. When the same
-- phone later signs in as another account, Expo can return the same provider
-- token and the API attempts a normal INSERT for the new user. The partial
-- unique index on push_tokens(token) WHERE active rejects that INSERT before
-- ownership can move, leaving the provider endpoint attached to the old user.
--
-- SECURITY BOUNDARY
--
-- Do not make a general cross-user mutation function callable by dawaee_app.
-- The only privilege crossing happens inside this trigger and only when BOTH
-- pieces of installation routing metadata match: provider token + device_id.
-- A caller who merely knows another Expo token cannot deactivate it using a
-- different installation id. The request itself is still authenticated and
-- RLS still requires the new push_tokens row to belong to app.user_id.
--
-- RACE BOUNDARY
--
-- The advisory transaction lock serializes competing claims for the exact
-- token/device pair. The old row is deactivated before the partial unique index
-- checks the incoming active row, so two account-switch requests cannot leave
-- two active owners or fail just because their transactions overlapped.

CREATE OR REPLACE FUNCTION app.transfer_push_token_on_account_switch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;

  -- Serialize one physical notification endpoint without holding a table lock.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.token || E'\x1f' || NEW.device_id, 0)
  );

  UPDATE push_tokens
     SET active = false
   WHERE active
     AND token = NEW.token
     AND device_id = NEW.device_id
     AND user_id <> NEW.user_id
     AND id IS DISTINCT FROM NEW.id;

  RETURN NEW;
END
$$;

-- Trigger functions are not an API. Keep this privilege boundary unreachable
-- as a direct function call from runtime roles.
REVOKE ALL ON FUNCTION app.transfer_push_token_on_account_switch() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transfer_push_token_on_account_switch() FROM dawaee_app;
REVOKE ALL ON FUNCTION app.transfer_push_token_on_account_switch() FROM dawaee_worker;

CREATE TRIGGER push_tokens_account_switch_transfer
BEFORE INSERT OR UPDATE OF token, device_id, active ON push_tokens
FOR EACH ROW
WHEN (NEW.active)
EXECUTE FUNCTION app.transfer_push_token_on_account_switch();

COMMENT ON FUNCTION app.transfer_push_token_on_account_switch() IS
  'Trigger-only atomic transfer of one active push endpoint when token and device_id identify the same installation under a different authenticated account.';
