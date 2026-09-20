# Proof-first email registration — 20 September 2026

## Status

Implemented locally after PR #32 head `2063485`; **not deployed, not merged, and
not included in a TestFlight build**. Full CI is still required for this exact
change set.

## Defect closed by the change

`POST /v1/auth/register` returned `409 identifier_taken` for an existing email
and account tokens for a new one. That disclosed membership in a medication
service. Creating the new account before email verification also let anybody
reserve another person's mailbox.

Returning a fake success only for an occupied address was rejected: the app
would store unusable tokens and strand the user. Storing the password chosen by
the anonymous requester was also rejected: a mailbox holder could click an
unsolicited link and unknowingly activate an attacker-chosen credential.

## Implemented protocol and file links

1. `routes/auth.ts` validates and rate-limits the address, creates a random
   bearer token and always returns the same `202 {accepted:true,...}` contract.
   It creates no user, credential, profile or session.
2. Migration `0095_verified_email_registration.sql` stores only the normalized
   email, token hash, locale, expiry and encrypted delivery job in a FORCE-RLS
   table. Runtime roles cannot read it directly.
3. An occupied address receives no registration job. The HTTP response is
   unchanged and does not wait for the provider.
4. The email link keeps the token in the URL fragment. The same-origin page asks
   the mailbox holder for their own name, password and confirmation. Only then
   does `app.complete_email_registration` atomically create the account, self
   profile, preferences and credential, and record the mailbox as verified.
5. Several rate-bounded requests for one free mailbox may coexist so an
   outsider cannot invalidate the owner's earlier link. The first successful
   completion serializes on the normalized mailbox and deletes the other links.
6. The mobile registration screen now requests only an email, explains the
   generic result, and sends the user to sign-in after completing the email
   page. No password is transmitted before mailbox proof.

The existing email-verification and password-recovery flows remain separate.
The registration worker queue uses the same encrypted payload, lease, retry and
idempotent provider boundary, with a distinct SQL queue.

## Verified locally

- TypeScript: shared, API and mobile passed.
- ESLint: all changed TypeScript/TSX files passed.
- 54 API/SQL/provider tests passed. The SQL suite applied all 95 migrations to
  a `NOSUPERUSER NOBYPASSRLS` owner in PGlite and exercised creation only after
  proof, occupied addresses, expiry, multiple links, queue leases, RLS and
  purpose binding.
- 14 mobile registration/sign-in lifecycle tests passed.
- Total targeted result: **68 tests, zero failures**.
- The full shared/core/mobile suite then passed: **1,348 tests across 174
  files, zero failures**. This covers client regressions but is not a substitute
  for the API/database matrix or a real-device registration journey.
- The native PostgreSQL reset could not run in this execution environment
  because the `psql` binary is absent. This is not recorded as a product pass;
  CI PostgreSQL 16/17 remains mandatory.
- A fresh cloud-browser attempt still failed while refreshing tabs with a
  20-second CDP timeout. No visual acceptance is claimed for this change.

## Release and compatibility gate

The installed iOS `0.1.0 (6)` expects tokens from the old one-step registration
response. Deploying the API alone would make new registration fail safely but
would strand that old client. Ship only after the updated mobile build and API
are verified as a coordinated change. Existing login and recovery are not
changed. Do not publish the API or a TestFlight build from these local results.
