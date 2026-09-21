-- Inspect only the fresh, unguessable token hash supplied by this request.
-- The API cannot read either private outbox. No mailbox or user identity is
-- returned. Enqueue + capacity reservation commit together in the caller.
CREATE FUNCTION app.account_email_job_pending(p_token_hash text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM account_email_challenges
    WHERE token_hash=p_token_hash AND payload IS NOT NULL
      AND completed_at IS NULL AND expires_at>now()
    UNION ALL
    SELECT 1 FROM email_registration_challenges
    WHERE token_hash=p_token_hash AND payload IS NOT NULL
      AND completed_at IS NULL AND expires_at>now()
  )
$$;
REVOKE ALL ON FUNCTION app.account_email_job_pending(text) FROM PUBLIC, dawaee_worker;
GRANT EXECUTE ON FUNCTION app.account_email_job_pending(text) TO dawaee_app;
