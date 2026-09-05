-- Disabling an account must kill its sessions permanently, not pause them.
--
-- 0023 made `disabled_at` block requests by checking it on every read. That
-- stopped a disabled account at once, which was the point — but it made the
-- stop REVERSIBLE, and reversible is wrong for what this column means:
--
--   1. an attacker holds stolen access and refresh credentials
--   2. an operator disables the account
--   3. the credentials stop working
--   4. the user changes their password, replaces the device, remediates
--   5. the operator re-enables the account
--   6. the attacker's original credentials work again
--
-- Step 6 defeats the entire purpose of the control. Disablement is a
-- compromise, abuse or safety response, and the sessions open at the moment it
-- is applied are exactly the thing being responded to. They must not come back
-- because someone later decided the account itself is fine.
--
-- The invariant this establishes:
--
--   disabled_at NULL -> non-NULL  : every live session is revoked, for good
--   disabled_at non-NULL -> NULL  : permits NEW authentication only
--
-- Enforced by a trigger rather than in a route, for the same reason the read
-- check was: nothing in the API writes this column. It is set out of band by an
-- operator with SQL access, so a route that remembered to revoke would be a
-- route nobody calls. At the table boundary there is no path that can skip it —
-- an operator's UPDATE, a future admin endpoint, or a bulk suspension all go
-- through the same trigger.
--
-- The read-time check from 0023 STAYS. It is now defence in depth rather than
-- the mechanism: the trigger makes disablement permanent, and the read check
-- catches any session that somehow exists while the flag is set.

CREATE OR REPLACE FUNCTION app.revoke_sessions_on_disable()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  -- Only the NULL -> non-NULL edge. Writing `disabled_at` again while already
  -- disabled changes nothing, so a repeated suspension, a timestamp correction
  -- or a bulk UPDATE that touches already-disabled rows does no further work
  -- and has no side effects. Clearing the column matches nothing here at all,
  -- so re-enabling can never un-revoke.
  IF OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL THEN
    UPDATE auth_sessions
       SET revoked_at = now()
     WHERE user_id = NEW.id
       AND revoked_at IS NULL;

    -- The device registrations go too. A disabled account must stop receiving
    -- medication reminders naming its own medications on a phone that may be
    -- the compromised one; re-enabling re-registers the device on next launch.
    UPDATE push_tokens SET active = false WHERE user_id = NEW.id AND active;
  END IF;
  RETURN NULL; -- AFTER trigger; the return value is ignored.
END $$;

-- SECURITY DEFINER because the operator setting `disabled_at` is not
-- necessarily the table owner, and `auth_sessions` carries FORCE ROW LEVEL
-- SECURITY: without it, a suspension issued by any other role would silently
-- revoke nothing and report success. Running as the owner makes the revocation
-- happen whoever performs the disable.
REVOKE EXECUTE ON FUNCTION app.revoke_sessions_on_disable() FROM PUBLIC;

DROP TRIGGER IF EXISTS users_revoke_sessions_on_disable ON users;

CREATE TRIGGER users_revoke_sessions_on_disable
AFTER UPDATE OF disabled_at ON users
FOR EACH ROW
-- The WHEN clause is the idempotence: the function body is not even entered
-- unless this is the transition into disabled.
WHEN (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL)
EXECUTE FUNCTION app.revoke_sessions_on_disable();

COMMENT ON TRIGGER users_revoke_sessions_on_disable ON users IS
  'Disabling an account permanently revokes every live session and deactivates '
  'its push tokens. Re-enabling permits new authentication only — credentials '
  'that existed before the disable never work again.';
