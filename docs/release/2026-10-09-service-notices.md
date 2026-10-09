# Service notices compatible with iOS 1.0.1 (21)

The existing app can present a regular title/body push. This change adds a same-origin, administrator-only web console at `/admin/notifications`, while keeping all mobile source, native configuration and build identifiers unchanged. A notice opens the existing app; it does not install an update or deep-link to the store.

The console uses existing password login, keeps its access token only in memory, and checks current admin membership on each API call. It does not grant administrator privileges or expose recipients, device tokens or health data. The public HTML is only a login shell.

Preview stores immutable content and a bounded recipient snapshot (maximum 1,000 accounts). Sending requires a separate confirmed request. The default audience is the administrator's own account for a phone test. The all-accounts audience is limited to the selected language, live registered devices and active self profiles. Eligibility is checked again at submit. New registrations are not silently added to an existing preview. The existing durable push outbox, default priority, retries and receipts are reused; notices respect quiet hours. There is no email or SMS fallback. Campaign replay is idempotent; external delivery still has the existing provider/worker retry semantics and is not exactly-once guaranteed.

This console is for operational service/update notices only. Promotional campaigns require separate consent and unsubscribe support; OS notification permission alone must not be treated as marketing consent. iOS 21 does not acquire a new in-app preference or navigation screen from this server change.

Email copy changes are limited to verification subject branding and the sender display name. Sender address, tokens, expiry, authentication and delivery provider are unchanged.

## Rollout

- Validate migration 0104 and the admin route/worker integration tests on PostgreSQL 16 and 17.
- Apply the additive migration through the established migration/recovery process; do not use the runtime role as schema owner.
- Deploy API and worker at the same tested commit for readiness coherence.
- Use an existing explicitly authorized administrator account; no privilege is granted by this patch.
- Log in, preview `حسابي فقط — تجربة`, confirm an owner-approved test, and verify receipt on a physical iPhone with build 21.
- Do not send an update-available announcement before the update is actually released. No campaign is created or sent by deployment itself.

Queued counts are not delivery or read receipts. The operator sees only their own last 25 campaigns. Historic drafts expire after 30 minutes. Reusing a campaign ID cannot change its content or enqueue a second copy.

Rollback: revert API/worker code together; leave the additive migration in place. Stop any newly queued service-notice deliveries explicitly if rollback is caused by a delivery defect. Never drop patient or medication tables or roll back the build-21 push registration repair.
