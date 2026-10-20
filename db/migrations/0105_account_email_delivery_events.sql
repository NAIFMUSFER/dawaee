-- Operational delivery evidence only: no recipient, OTP, URL or raw payload.
-- Append-only events preserve out-of-order deliveries instead of allowing a
-- late `sent` event to overwrite `delivered`. Keep a rolling 30-day window.
CREATE TABLE account_email_delivery_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 200),
  email_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'email.sent','email.delivered','email.delivery_delayed','email.bounced',
    'email.failed','email.suppressed','email.complained')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_email_delivery_events_message_idx ON account_email_delivery_events(email_id, occurred_at);
CREATE INDEX account_email_delivery_events_retention_idx ON account_email_delivery_events(received_at);
REVOKE ALL ON account_email_delivery_events FROM PUBLIC, dawaee_app, dawaee_worker;
ALTER TABLE account_email_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_email_delivery_events FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM app.ensure_definer_policies();

CREATE FUNCTION app.record_account_email_delivery(p_event_id text, p_email_id uuid,
  p_event_type text, p_occurred_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE inserted_count integer;
BEGIN
  INSERT INTO account_email_delivery_events(event_id,email_id,event_type,occurred_at)
    VALUES(p_event_id,p_email_id,p_event_type,p_occurred_at)
    ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  DELETE FROM account_email_delivery_events WHERE received_at < now()-interval '30 days';
  RETURN inserted_count = 1;
END $$;
REVOKE ALL ON FUNCTION app.record_account_email_delivery(text,uuid,text,timestamptz) FROM PUBLIC, dawaee_worker;
GRANT EXECUTE ON FUNCTION app.record_account_email_delivery(text,uuid,text,timestamptz) TO dawaee_app;
