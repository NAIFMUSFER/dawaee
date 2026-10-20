# Verification email delivery investigation

Two registration emails on 19 October were accepted by Resend within seconds of
the API requests but remained `delivery_delayed`. Sender DKIM and return-path
SPF are verified; the parent domain publishes relaxed-alignment DMARC. Provider
quota is available. The connector does not expose the receiving server's SMTP
deferral reason. These findings do **not** establish that Gmail delivery is fixed.

## Change

- Retain the provider message ID in the existing safe acceptance diagnostic.
  Acceptance is explicitly distinguished from delivery.
- Receive timestamped, signed Resend events at `/v1/webhooks/account-email`.
  Verify the exact raw bytes with Svix before JSON parsing. The raw parser is
  encapsulated so existing iOS 21 authentication JSON requests are unchanged.
- Persist only event ID, provider email ID, event type and timestamps. No email
  address, subject, message body, token, OTP or signature is retained.
- Deduplicate retries transactionally and acknowledge only after durable storage.
  Preserve out-of-order events. Restrict writes to a definer function and deny
  direct table access to both runtime roles. Purge older than 30 days on ingestion.
- Ignore other sending projects hosted in the same Resend account.

This change observes delivery. It does not retry already accepted messages,
lengthen OTP validity, bypass verification, alter addresses or remove suppressions.
No email/SMS is sent by deployment. No mobile release is required for telemetry;
it does not add a delivery-status screen to the installed app.

## Deployment

1. Pass CI on PostgreSQL 16 and 17 and existing security gates.
2. Merge the exact tested head. Deploy the worker first so its existing migrator
   applies additive migration 0105 under the correct owner and ledger checksum.
3. Create a Resend webhook for `email.sent`, `email.delivered`,
   `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`,
   and `email.complained`. Keep the returned signing secret out of source/logs.
4. Set `RESEND_WEBHOOK_SECRET` on the production API through Render's merge-only
   environment-variable update. Preserve all existing configuration. This key is
   managed as a service secret; it is intentionally not a Blueprint literal.
5. Deploy the API at the same commit, verify `/version`, `/health/ready`, and
   rejection of unsigned webhook requests. Inspect subsequent real provider events.
6. Obtain the delayed Gmail message's SMTP diagnostic from the provider dashboard
   or support before selecting a sender/routing/content remedy. An authorized
   end-to-end inbox check is still needed to prove actual delivery.

Rollback: deploy the preceding API/worker commit together and disable the webhook.
Leave additive migration 0105 in place. Do not change patient tables or auth rules.
