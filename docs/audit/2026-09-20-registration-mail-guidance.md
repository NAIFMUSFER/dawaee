# Registration mail feedback — 2026-09-20

## Report and live evidence

The owner reported no registration email after the generic accepted screen on
the isolated audit preview. The page must explain what an accepted request
means and provide a recovery path without revealing account existence.

- Preview under investigation: `75e03c1b84c978423c32167ae4221f70eec11ce1`,
  schema 0095, the same source tree as PR head `e8d1b33`.
- A registration POST at 08:27:38 UTC returned 202. No new corresponding
  outbound message appeared in the provider inventory. The recipient was not
  on the provider suppression list. No recipient address or link token is
  recorded here.
- One fresh synthetic registration probe at 08:34:45 UTC was accepted. Resend
  reported its registration email delivered at 08:34:47 UTC. This verifies
  current provider delivery for that synthetic recipient, not the owner's
  mailbox. The link was not redeemed and no account was created by this probe.
- Migration 0095's `app.request_email_registration` deliberately returns
  without enqueueing a registration email for an existing address. The route
  preserves the same 202 contract for available and occupied addresses.
- An existing preview account is therefore a plausible explanation, **not a
  confirmed diagnosis**. The narrow read-only database lookup could not run:
  the Render database connector returned an EOF/TLS-required connection error.
  No transport setting or account state was changed to work around it.
- `/forgot-password` returned HTTP 200 HTML; the preview version still matched
  the expected commit. HTTP checks do not prove rendered interface usability.
- After the owner supplied DNS screenshots, Resend reported `mail.tadawee.net`
  verified with sending enabled. DKIM, the `send.mail` MX/TXT records and the
  `rsend.mail` CNAME were individually verified and matched those screenshots.
  No DNS record needed changing on this evidence. Direct DNS resolution from
  the execution container was refused, so this is provider verification, not
  a claimed independent authoritative-DNS probe. The official
  [Resend GoDaddy guide](https://resend.com/docs/knowledge-base/godaddy) describes
  these subdomain names; existing root-domain mail records were preserved.

## Written

- Arabic and English registration feedback now describes the existing-account
  case, inbox/spam check and the 30-minute link expiry. It reports receipt of a
  request, not confirmed email delivery or account creation.
- The accepted screen uses an informational banner and an explicit recovery
  button leading to the existing forgot-password screen. Navigation carries
  no email, token or credential in the route and sends no automatic reset.
- The API, migration, enumeration protection, sender and provider configuration
  are unchanged. No password was set, no user recovery email was requested by
  the agent and no old/new account was reset or deleted.

## Tested

- 31/31 tests across four existing suites: auth connection screens, password
  recovery screen, email verification screen and shared i18n.
- The accepted-registration case now exercises the recovery button and asserts
  that navigation does not make a second anonymous request or sign the user in.
- Mobile TypeScript, targeted ESLint and whitespace checks passed.
- The first default test invocation stopped before collecting tests because
  its generated web directory contained two entry bundles. The focused test
  configuration used above excludes that unrelated global web build; it is
  not represented as a successful full-suite run.
- A separate Expo web export into a fresh output directory succeeded, followed
  by the unchanged web inliner/hardening checks. No build guard was disabled.

## Publication and limits

This checkpoint is included with the source repair in draft PR #32. The
previous head's successful CI does not certify this new head; current CI and
any preview promotion are recorded separately in the PR checkpoint.

The browser's previously recorded CDP failure still prevents rendered visual
acceptance. The owner's actual recovery/registration result remains open,
alongside three-role interface and physical iPhone notification acceptance.
No production deployment, PR merge or new TestFlight binary is included.
