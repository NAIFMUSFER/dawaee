# Render request-path privacy evidence — 2026-09-10

Status: **OPEN RELEASE BLOCKER**

This note records sanitized black-box evidence gathered from the production `dawaee-api` Render request-log surface. No production mutation or deployment was performed while gathering it.

## Proven behavior

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

A privacy fix is complete only when current mobile clients no longer place stable patient, medication, dose, schedule, or caregiver-relationship identifiers in the public path/query and dose-action semantics are not encoded in a path containing a stable dose identifier.

Legacy parameterized API routes may remain temporarily for rollout compatibility, but new clients must use fixed-path transports and regression tests must prove the URL itself is free of the protected identifier.

## Progress at this commit

- `profileId` mobile transport has been moved to `x-dawaee-profile-id` while legacy query input remains readable server-side during rollout.
- Caregiver relationship mutations now have fixed-path alternatives that carry `relationshipId` in JSON and the mobile client has been cut over to them.
- The endpoint authorization inventory has been updated so those new caregiver fixed-path routes stay inside the unauthenticated/session sweep instead of becoming an unclassified surface.

## Still open

Medication, schedule, and dose identifier transports remain to be cut over and verified. The PR must remain draft and must not be deployed solely because CI is green; this black-box privacy finding remains open until those transports and the final production verification are complete.
