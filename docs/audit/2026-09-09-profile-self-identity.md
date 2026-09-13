# Caller-relative self identity at the API boundary

Baseline audit head: `a2419191f5c082121ca7f64997b501e92fab82b2` (CI 208 / 34318990998 and Security 209 / 34318990935 succeeded before this change). Production main remains `4cf23531dfaa5cc7c3790b473f8b4ff9f88d9f72`.

## Proof before change

`apps/api/src/services/access-service.ts`, `listAccessibleProfiles`, returned the stored `pp.is_self` unchanged even for a different user's caregiver view. The whole audit source was checked against blob `593b67672a87ea76dc0c09dfd5a15b58f48c23e2` (9,361 bytes). The production main source independently has the same mapping at lines 187-200 (blob `8d518d65ce1031fd3fc26ce631e7a0876011b49c`).

An exact extraction of the function (verified against the hashed complete source) executed with controlled query results returned `{id:PATIENT,isSelf:true,role:caregiver}` and `{id:SELF,isSelf:true,role:owner}` together. The current AppProvider bootstrap's `.find(p => p.isSelf)` selects the older foreign patient first; Today consumes isSelf both for local-reminder eligibility and the self-or-permission UI predicate. The latter therefore advertises an action a view-only caregiver cannot actually perform.

Six local assertions: **3 failed / 3 passed before**, **6/6 after**. Query results were synthetic; this is serializer/caller-contract proof, not a real RLS bypass or physical-device incident.

A production aggregate was read at **2026-09-09 06:32:15.114939 UTC**, in a READ ONLY transaction with a 5-second timeout: **2 active caregiver relationships**, both to a non-archived self profile whose owner/linked user is not that caregiver. The query selected only counts, not names, tokens, medications or relationship identifiers. This establishes the relevant production data shape, not that either person saw a disclosure on their phone.

## Minimal fix and regression boundary

Serialize `isSelf: r.is_self && isOwner`, using the already-established caller ownership/linked-user calculation. Do not change stored profile identity, SELECT/RLS conditions, role, granted permissions, ordering or authorization helpers. An owner's dependent profile remains owner-accessible but not self; a caregiver remains caregiver.

Six permanent database-backed API tests use the existing isolated PostgreSQL/Fastify harness: register patient and caregiver, create a dependent profile and medication, invite/accept the read-only relationship, and inspect authenticated profile responses. Positive controls preserve the patient's self and the caregiver's granted medication read; the negative control requires HTTP 403 for unauthorized medication creation and verifies no partial medication was written. This is API/database integration, not native E2E. Full CI/security must be checked on the resulting head.

## Explicit remaining work

This does not close the separate settings caller that rebuilds reminders using activeProfile without verifying self eligibility, owned-dependent edit UX, stale preference-save/bootstrap responses, full offline restoration or physical notification/provider E2E. These remain on the audit checklist. No production records, policies, deployments or main-branch commits were changed; PR #14 stays DRAFT.
