# Authentication startup and live interface checkpoint

The user reported a sign-up transport failure in the isolated preview. The
hosting request log records `POST /v1/auth/register` returning gateway `502` at
12:38:41 UTC on 19 September 2026; the preview API began listening at 12:39:13
after its cold-start migration/role checks. This is evidence of unavailable
upstream service during startup, not evidence of an incorrect password.

The UI incorrectly reused the medication offline/sync notice under the password
field. Sign-in and sign-up now show an independent connection banner and a
visible waiting explanation. They wait for an anonymous, credential-free
`GET /health` acknowledgement from this API before sending credentials. Read-only
probes are bounded to 75 seconds and cancel when the screen closes; explicit
HTTP rejections are not retried. Credential POSTs are never automatically
replayed. Duplicate clicks and late screen responses are fenced. A lost
registration response states that completion is unknown and suggests sign-in
before another registration attempt. Recovery, verification and onboarding
also use the neutral connection message rather than claiming dose reminders.

Validation: 1,131 mobile/shared tests in 158 files passed, including nine
transport/readiness regressions and twelve tests executing the actual sign-in
and sign-up screens with controlled I/O. Mobile TypeScript, touched ESLint and
diff checks passed. These are regression checks, not proof of native UI behavior.
The preceding head `02748eb` passed full CI (2,780 tests on each PostgreSQL 16/17
job) and Security; this follow-up needs its own candidate gates.

After the user completed the browser step, the live preview showed the signed-in
Today page and navigation, establishing successful preview access. The patient
interface trial then reached manual medicine entry, uploaded a synthetic image,
and entered a medicine note and Arabic stock digits. Persisted medicine and dose
outputs are being checked next. No account password, mailbox token, personal
contact details or real health records belong in this checkpoint.

Production and TestFlight remain unchanged. No final release is approved.
