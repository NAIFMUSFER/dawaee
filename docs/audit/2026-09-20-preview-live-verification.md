# Isolated preview: live integration and mailbox verification — 20 September 2026

**Not release approval.** This checkpoint deploys the reviewed candidate to the
existing isolated audit preview and tests its public HTTPS endpoints with three
new synthetic accounts. It does not claim a visible browser walkthrough,
physical notification delivery, production rollout, or a new native binary.

## Written, tested and deployed are separate

- Reviewed source: `b85cc25fae6d00879d6c91dc17890cf66aa1c09b`, tree
  `74c05a8cfadc1c9ebee4d31c15df9d445c9176e7`. Its functional registration source
  is `48f16d84f9af9fb5cef1ebe74642b8745cdc7b5d`; the later source commit only
  reconciles audit documentation.
- That exact source head passed [CI #1146](https://github.com/NAIFMUSFER/dawaee/actions/runs/35492954803)
  and [Security #1148](https://github.com/NAIFMUSFER/dawaee/actions/runs/35492955023):
  2,885 tests / 377 files on each of PostgreSQL 16 and 17; all 95 migrations;
  RLS 110 attempts, zero unexplained failures/open findings; mobile bundles,
  typechecks, dependencies, container and runtime-recovery gates.
- Before deployment, the PR head, local tracked tree, preview branch and active
  deployment were checked. The old preview had no independent source changes.
  No local tracked work was overwritten. The preview-start safety self-test
  passed 44 guards and preview-web-build self-test passed 10 guards.
- The existing preview branch was advanced without force to
  `ff1bd1bc7ce86f0bc10364318ea57098a60c03c0`, preserving both its old parent and
  the reviewed source parent, with exactly the source tree above. This was not
  a merge of PR #32 into its base or main.
- The branch update caused **one** existing Render auto-deployment:
  `dep-dannphh7lnhs73ebjt30`, service `srv-daipkbuk1f9s73952trg`. Started
  06:27:18 UTC; live at **06:29:47 UTC**. No duplicate deployment was requested.
- Preview: <https://dawaee-audit-preview.onrender.com>. `/version` returned the
  exact preview commit and `0095_verified_email_registration.sql`.
  Startup logged 95 required / 95 applied migrations. `/health/ready` returned
  HTTP 200 ready at 06:30:30 and 06:34:16 UTC; recovery options returned
  `provider=email, available=true`.

The preview retains its isolated test database and explicit genuine-account-mail
opt-in. Push/OCR are mock providers, storage is local/ephemeral, and the free
service can sleep. These checks do not establish production R2 durability,
OCR accuracy, SMS delivery, push receipt, or availability guarantees. No provider,
paid resource, production setting, user reset, or native build was created.

## Live checks: 27 grouped assertions passed

Checks ran 06:33:50–06:43:19 UTC through the deployed HTTPS service. Three
synthetic patient/caregiver/nurse accounts were registered; no real patient
data or existing accounts were used. Each phase refused to run against a
different origin or commit. No SQL fixture bypass was used for these accounts.

| Area | Observed result |
|---|---|
| Registration | All three requests returned the same 202 accepted contract without sessions. Patient login before mailbox completion returned 401. |
| Real email delivery | Three registration messages arrived in the connected test inbox at 06:33:55–56 UTC (Arabic for patient/caregiver, English for nurse). Each delivered link targeted the preview `/account-email` page, with the bearer token in the fragment and the correct purpose. |
| Proof and login | Each received token completed registration through HTTP. Email/password login succeeded; `/me` reported verified email and no reserved phone; each account initially had exactly its own profile. |
| Invitation isolation | Both helpers received 404 for patient data before acceptance. Recipient-bound previews exposed the offered role/permissions. A different recipient could not preview the invitation. Merely previewing did not grant a patient profile. |
| Explicit consent contract | Submitting a different permission set returned 409. Submitting the exact reviewed role/permissions granted the patient profile. This tests the API consent boundary, not whether the consent screen is usable. |
| Medication notes | A synthetic medication produced a same-day dose. Patient, accepted caregiver and nurse could read back its medication note. |
| Dose permission and history | The read-only caregiver's confirmation returned 403. The authorized nurse confirmed with a synthetic dose note; all three could read the recorded dose and note in history with delegated confirmation attribution. Stock changed from 4 to 3. |
| Access removal | Revoking only the synthetic caregiver relationship immediately denied that caregiver patient access. The account itself was retained. |
| Private image data path | A repository-owned PNG test image was uploaded, finalized and attached. Patient and authorized nurse downloaded identical bytes, and the dose response referenced the attached image. An unsigned read returned 403; the revoked caregiver could not obtain a new signed read capability (404). This does not prove rendering on a dose card. |
| Real password recovery | The recovery message arrived at 06:39:26 UTC. Its received token reset only the synthetic patient's password. Old access, old refresh and old password were all rejected with 401; the new password logged in successfully. Completed at 06:42:36 UTC. |
| Session cleanup | `logout-all` succeeded for all three accounts, and each old access/refresh was rejected. Finished 06:43:19 UTC. No new account was deleted and no bulk reset was repeated. |

The temporary probe kept credentials/tokens outside the repository in a
restricted runtime state file; no password, token, signed URL or private email
body is included here. The single synthetic medication ended the same day,
and its test dose was already confirmed. The three accounts remain available
for later authorized testing, with no active probe sessions.

## HTTP document check and actual browser boundary

- `/`, `/sign-up`, `/sign-in`, and `/today`, requested with browser
  `Accept: text/html,application/xhtml+xml`, returned HTTP 200 with the same
  2,054,452-character HTML document and CSP. `/v1/not-found` still returned
  JSON 404 rather than the app document.
- An initial generic fetch of `/sign-up` returned JSON 404 because it did not
  ask for HTML. Reading `middleware/error-handler.ts` and repeating the request
  with the real document Accept header confirmed intended content negotiation;
  **no fallback code was changed for this false alarm**.
- The supported cloud browser was retried after deployment. A fresh-tab attempt
  failed with `CDP operation refresh tabs timed out after 20000ms` before a
  rendered page was available. Thus no browser sign-in, screenshot, every-button
  pass, rendered note/photo, or visible three-role journey passed in this run.
- The Render application-log query through 06:43:54 UTC found no `unhandled
  error`. Logged 401/403/404/409 application errors corresponded to intended
  negative checks; the mere presence of an error-level label was not treated
  as an unexpected failure.

CI managed-database smoke remains a different evidence class: it makes the real
registration request, checks no user exists, then inserts a **known disposable
challenge** with the restricted database helper before HTTP completion. It does
not receive the originally queued email. The mailbox evidence in this checkpoint
uses the actual delivered tokens and is not inferred from that smoke test.

## Remaining gates

1. Visible Arabic/English registration and reset, all patient/caregiver/nurse
   journeys, notes and image cards, and permission-dependent buttons.
2. Physical iPhone/Firebase phone proof and phone login; notification delivery
   foreground/locked/stopped/offline, duplicates, window renewal, snooze and a
   separate caregiver device. The preview's mock push cannot close these.
3. Deletion grace-date and restore-screen acceptance on the candidate, native
   language restart, genuine operator/privacy/terms and Apple/encryption/
   continuity/PDPL decisions from the reconciliation matrix.
4. Coordinated native/API release: installed iOS 0.1.0 (6) expects the old
   registration response. Do not deploy the new production API alone or treat
   this preview deployment as authorization for final release.

Final read-only health checks confirmed the preview ready at 06:43:58 UTC,
and production still at `63b5b8d` / schema 0088, ready at 06:44:05 UTC.
Production was not redeployed. No TestFlight build or final submission was made.
This evidence does not supersede the
unmet acceptance gates in [the reconciliation matrix](2026-09-19-legacy-audit-reconciliation.md).
