# Isolated preview account-email verification

The preview uses its own database and restricted API/worker roles. Its current
default disables account email, so newly created accounts cannot finish email
verification. Unverified older accounts are also held by the current client
gate. A previously verified preview account may sign in with its own valid
credentials; production accounts are not copied into the preview.

The optional `AUDIT_ACCOUNT_EMAIL_DELIVERY=1` enables real account mail only on
the exact managed audit service, origin and database. `NODE_ENV=test` remains
required. Other test servers keep the no-mail timer rule. Bootstrap refuses a
partial configuration or a production link origin before migrations. Only the
API receives the approved email settings; the worker receives no mail key.

Required API settings are `ACCOUNT_EMAIL_PROVIDER=resend`,
`ACCOUNT_EMAIL_FROM=accounts@mail.tadawee.net`,
`ACCOUNT_EMAIL_SENDER_VERIFIED=true`,
`ACCOUNT_EMAIL_BASE_URL=https://dawaee-audit-preview.onrender.com`, and a dedicated
Resend sending-only key scoped to `mail.tadawee.net` in hosting configuration.
Do not place the key in Git, output, this document or a client bundle. Unset the
opt-in or set it to `0` to retain the disabled preview behavior.

On 19 September the connected Resend domain listing showed `mail.tadawee.net`
verified and sending enabled. This code change does not provision credentials,
change hosting settings, send a message, or establish successful inbox delivery.
Those steps and actual verification-link completion remain pending operator
execution. Verification still requires the current password, a real mailbox
link and the existing expiry, single-use and database checks; all rate/send
budgets remain. No fixture account is automatically verified.

After real email verification, the three-role UI trial can use invitations to
the exact verified mailboxes. Browser phone verification remains unsupported;
phone proof and native notification display require their separate device
checks. Push/OCR remain mocked in this preview.

The preceding candidate CI had 2,734 passing and seven failing tests in 367
files. Native PostgreSQL migration/RLS/managed smoke/orphan recovery gates and
security checks passed. The seven scoped failures have since been repaired and
await the next full CI run together with this opt-in change. All 37 local opt-in
checks and 20 existing related tests passed. They mock delivery I/O and do not
substitute for that run or real inbox verification.
