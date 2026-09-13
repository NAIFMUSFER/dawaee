# Render request-path privacy evidence — 2026-09-10

Status: **CODE REMEDIATION VERIFIED; PRODUCTION VERIFICATION PENDING**

This note records sanitized black-box evidence gathered from the production `dawaee-api` Render request-log surface and the audited remediation now present on `audit/e2e-red-white-black-2026-09-09`. No production mutation or deployment was performed while gathering or updating this evidence.

## Proven production behavior

Render's platform request logs retain the public HTTP path/query before Dawaee's application logger can redact it. Historical production entries included stable health-adjacent identifiers and, for dose mutations, action semantics.

Sanitized examples observed in production:

- `GET /v1/today?profileId=<patient-profile-uuid>`
- `GET /v1/care-circle?profileId=<patient-profile-uuid>`
- `GET /v1/medications/<medication-uuid>`
- `GET /v1/medications/<medication-uuid>/stock`
- `PUT /v1/caregivers/<relationship-uuid>/notification-rules`
- `DELETE /v1/caregivers/<relationship-uuid>`
- `POST /v1/doses/<dose-uuid>/taken`
- `POST /v1/doses/<dose-uuid>/snooze`

The same platform records also associate request metadata such as source address and user agent with the path. Raw identifiers and addresses are intentionally omitted from this repository note.

## Remediation contract

A privacy fix is complete in code only when current mobile clients no longer place stable patient, medication, dose, schedule, or caregiver-relationship identifiers in the public path/query and dose-action semantics are not encoded in a path containing a stable dose identifier.

Bearer capabilities used by invitation and emergency-card flows must likewise stay out of HTTP path/query transport.

Legacy parameterized API routes may remain temporarily for rollout compatibility, but current clients must use fixed-path transports and regression tests must prove the network URL itself is free of the protected identifier.

Production closure is a separate step: the remediated client/API must be deployed in a controlled release and Render request logs must then be re-inspected without exposing raw identifiers in audit evidence.

## Code remediation now verified

The audited branch now satisfies the code-side transport contract:

- `profileId` is removed from mobile request query strings and transported as `x-dawaee-profile-id` where profile scope is required.
- Medication resource IDs are converted to fixed public paths and transported as `x-dawaee-medication-id`.
- Schedule resource IDs are converted to the fixed `/v1/schedule` path and transported as `x-dawaee-schedule-id`.
- Dose mutations use the fixed `/v1/dose/action` path; the dose occurrence ID and action (`taken`, `snooze`, `skip`, `undo`) travel in the JSON body instead of the public path.
- Caregiver relationship mutations use fixed public paths with the relationship ID in the authenticated request body.
- Dose-history `profileId` and `medicationId` filters no longer enter the public query string; non-sensitive date filters remain normal query parameters.
- Caregiver invitation bearer tokens are generated in a URL fragment, not a path or query string.
- Emergency-card bearer capabilities are generated in a URL fragment and are sent to the fixed scan endpoint using `Authorization`, not a path token.
- The fixed-path API routes reuse the established authenticated handlers/authorization checks. Cross-account and cross-profile regression tests cover the rewrites so URL privacy does not become a BOLA bypass.

The implementation head immediately before this documentation update (`3cfccf518d19c904ace21ad7d43a5105cfda8f2e`) passed the complete CI workflow, including PostgreSQL 16 and 17, mobile, Docker, dependency gates, RLS/migrations/integration tests, and the complete Security workflow (CodeQL, container/Trivy and secrets). The documentation-only commit that updates this note must independently pass its newly triggered gates before it is considered verified.

## Still open before production closure

- **No production deployment has been performed from this audit branch.** Historical production logs therefore still describe the old deployed client/API behavior and do not prove that the remediated transport is live.
- After a controlled deployment, inspect Render request logs again and prove that current client traffic uses only the fixed public paths and non-sensitive queries described above.
- Production API availability is a separate release blocker: the live `dawaee-api` remains on Render's Free plan and production request evidence includes cold-start/service-unavailable responses. The audited `render.yaml` requests a non-sleeping Starter API plan, but that infrastructure change has not been deployed.
- S3/R2 upload tickets still do not cryptographically bind the declared `byteSize` to the actual uploaded object. This is tracked separately because signing a browser-forbidden or provider-incompatible `Content-Length` header without compatibility proof could break uploads rather than safely enforce the limit.

Until the production verification is complete, this finding is **not closed for release**, even though the audited code-side remediation has passed its implementation and regression checks.
