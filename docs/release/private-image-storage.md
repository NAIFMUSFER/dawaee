# Private image storage deployment checks

Image storage has three separate acceptance checks: authenticated object I/O,
browser access, and worker cleanup. Success in one does not establish the others.

## Keep API and worker configuration aligned

Use the same existing private bucket and provider on both production services:

- `STORAGE_PROVIDER`
- `STORAGE_BUCKET`
- `STORAGE_ENDPOINT`
- `STORAGE_REGION`
- `STORAGE_ACCESS_KEY_ID`
- `STORAGE_SECRET_ACCESS_KEY`

Copy secrets only through the hosting provider's secret settings. Record the
deployment IDs and exact source commit after activating saved settings. Do not
publish keys, signed URLs, account credentials, or medical images as evidence.
An empty replacement bucket cannot establish deletion of the original objects.

## Allow the production web origin in R2 CORS

The current verified production web origin is
`https://dawaee-api.onrender.com`; its existing bucket is `tadaweeimages`.
The [production policy](r2-cors.production.json) is in Cloudflare dashboard JSON
format. In R2, open the bucket's **Settings → CORS Policy** and save the policy.
If there are already other required rules, preserve them. Recheck the actual
web origin whenever hosting changes; the local-storage audit preview does not
require access to this production bucket.

The policy permits `GET`, `PUT`, and `HEAD` with `Content-Type` and
`If-None-Match`. The upload client uses the headers returned by the API's signed
ticket. Do not remove the conditional-write header to work around CORS: it
prevents an upload ticket from overwriting finalized bytes. Browser DELETE
permission is unnecessary; worker deletion is server-to-server. CORS does not
require enabling public bucket access.

After saving, make a preflight request to an object endpoint in the same bucket
with these request headers:

```text
Origin: https://dawaee-api.onrender.com
Access-Control-Request-Method: PUT
Access-Control-Request-Headers: content-type,if-none-match
```

Verify a successful OPTIONS response (R2 returned 204 in the production check)
with the exact allowed origin, PUT in the allowed methods, and both requested
headers. Check the response, not merely the presence of JSON in an editor.
Then upload through the actual web UI, finalize, reopen the medication, and
verify the image in the due-dose and history interfaces. A CLI upload or an
OPTIONS check alone does not pass this interface acceptance gate.

Official reference: [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).

## Verify storage I/O and cleanup independently

Use a separately identified synthetic account and a non-medical image. Require
successful upload/finalization and compare downloaded bytes with the fixture.
Close its sessions and use the ordinary deletion-request lifecycle when done.

Inspect a housekeeping run that started after the worker deployment. Its
upload/account-deletion steps must not report provider errors. Preserve the
account-erasure grace period and bytes-before-metadata ordering. Do not shorten
retention, replay a completed account reset, remove metadata by hand, or label
a successful no-op deletion as verified removal of original bytes.

Production commit `63b5b8d` runs housekeeping after 60 ticks (roughly 59 minutes
after startup with 60-second ticks). The later candidate starts it on the first
tick and adds readiness coverage; consult the deployed commit before deciding
when the first result should exist. Job success does not prove device display
of medication notifications.

## Evidence from September 19, 2026

- At 19:54 UTC, production R2 accepted a 25,595-byte synthetic PNG; finalization
  succeeded and signed download matched its SHA-256.
- Browser preflight returned 403 with `CORS not configured for this bucket`,
  both with Content-Type alone and with the conditional-write header included.
- After the owner saved the policy, preflight returned 204 at 20:05:16 UTC,
  allowing the exact production origin, GET/PUT/HEAD, and both upload headers.
- The probe account's own deletion request was recorded at 19:57:09 UTC,
  scheduled for October 3 at 19:57:09 UTC. Logout succeeded and reuse of its
  access token returned 401. Its image remains under normal erasure retention.
- First post-deployment housekeeping started at **20:35:22.198 UTC** and
  succeeded. The new production worker instance logged completion at
  **20:35:23.273 UTC**, with **605 total retention items and zero failures**.
  That aggregate is not an image count. Read-only object counts changed from
  **9 total / 2 unfinalized / 7 finalized** before the run to
  **7 total / 0 unfinalized / 7 finalized** afterwards. The two abandoned upload
  metadata rows were removed through the worker's provider-delete-first path,
  with no manual SQL deletion. This resolves the previously observed
  unconfigured-provider errors for this run. Original object bytes and bucket
  identity were not independently checked before deletion; successful
  idempotent DELETE does not prove those bytes previously existed there.

These are protocol and lifecycle results. The cloud-browser timeout left the
new UI trial incomplete. Full account erasure remains subject to the original
14-day grace; finalized images were retained. PR #32 records subsequent acceptance.
