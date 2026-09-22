# F1 — recovery after a committed refresh response is lost

Base candidate: `ebff1633dec158aa1bc07f97afab56cd7c56c33e`.
Finding: **confirmed**. Source reconciliation and hosted evidence were written
before this repair on `audit/independent-verification-20260921`.

## Failure and pre-fix evidence

`independent-audit-f1.test.ts` runs the real auth route, SQL rotation, mobile
client and AppProvider. A transport double loses the first response **after**
the database commits. Before the repair, the next refresh returns 409 and the
client clears authentication, cancels reminders, purges two queued actions and
destroys the cache key. The test was committed before runtime changes.

`refresh-retry-proof.test.ts` was also committed before the repair: six of its
eleven initial cases failed (recovery, correct-proof retry within the existing
grace, and malformed-proof rejection). Five existing rejection controls passed.
An initial fixture omitted the required user identifier; that fixture was
corrected and rerun before editing runtime code. Its constraint failure is not
counted as product evidence.

## Protocol and security boundaries

1. The client obtains 32 cryptographically random bytes through Expo's async
   native entropy API. There is no `Math.random` fallback. It atomically stores
   the hexadecimal `retryNonce` alongside the old token pair in the existing
   secure-store entry **before** making the refresh request.
2. The optional request field opts into recovery. The API derives a 48-byte
   successor using HMAC-SHA-384, the existing server secret, an explicit protocol
   domain, the nonce and the presented token. No new secret or environment
   setting is introduced. The database stores token and nonce digests only.
3. New migration **0096** adds a nullable proof digest and an API-only SECURITY
   DEFINER wrapper. The wrapper uses the existing account advisory lock before
   session row locks. First rotation delegates to the existing function, which
   retains push ownership transfer and the established revocation behavior.
4. A retry with the same proof may obtain **only the exact immediate successor**
   while it is still live, unexpired, on the same account/device, and owned by an
   enabled account. It creates no session, follows no replacement chain and
   extends no expiry. Missing or wrong proofs retain the existing 30-second
   grace and subsequent lineage revocation. Legacy clients use the unchanged
   rotation function. Both HTTP and persistent request budgets remain intact.
5. After success, the client writes the new pair before adopting it in memory.
   If that write fails, it retains the old pair **with its recovery proof** and
   reports temporary unavailability. A later attempt or restart can recover;
   it does not rotate an unpersisted successor into another generation.
6. Real authentication rejection still signs out and purges local state.
   Session-generation fences remain around asynchronous storage and HTTP work,
   so a late response or proof write cannot restore an old account.

The proof is a bearer capability in addition to the old token. Possession of
both can recover their still-live successor; this is why both belong in the
same hardware-backed credential store and why the nonce is redacted in shared
API/worker logging. Device IDs, IP addresses and a longer unauthenticated grace
period are not accepted as recovery authority. No response token is cached in
plaintext in PostgreSQL. Rotating the server secret invalidates deterministic
recovery, consistent with its existing session invalidation contract.

Alternatives considered: keeping every 409 locally would defer the same failure
and later invoke theft revocation; lengthening the grace would weaken that
guard; storing plaintext successor tokens would expose credentials in database
copies. The chosen capability preserves these boundaries while making a single
committed attempt repeatable.

## Tests and their limits

- Original loss reproduction: changed from `[200,409]` to `[200,200]`; zero
  cancellation, token clearing, cache purge or key destruction; both queued
  confirmations survive. The real route and SQL execute in PGlite with forced
  RLS and a non-superuser migration owner.
- SQL/HTTP controls cover missing/wrong proofs, malformed proofs, legacy
  requests, exact successor/expiry/row count, disabled users, revoked/expired
  successors, already-rotated successors and API-only function privileges.
- Native PostgreSQL tests hold actual transactions and observe lock waits for
  concurrent identical attempts and revocation racing a retry. PGlite alone
  cannot establish those concurrency properties; CI must run these on 16 and 17.
- Client controls exercise restart, failed preflight/successor writes, secure
  storage parsing, single flight, explicit rejection, transient 429/503,
  transport timeout, account switches and entropy failure. Native hosts are
  doubles; this is not an iPhone or Android device test.
- Existing storage expectations were updated to require the complete persisted
  old pair **and** its proof, not merely to tolerate an old token. The legacy
  explicit-clear controls and genuine-rejection controls remain. The timeout
  transport double now honors an already-aborted signal, as native fetch does.

Full Vitest, ESLint, server/mobile typechecks, RLS probes and twice-applied clean
migrations must pass on the **published PR head** before integration or preview
deployment. The PR carries the final job IDs and counts. This local environment
has no native PostgreSQL client/server; unavailable native tests are not passes.

## Compatibility, deployment and rollback

The server contract is additive: `retryNonce` is optional, and build 6 and build
10 continue to use their original refresh contract. They do not gain recovery
without the updated client. No Apple settings, signing credentials, TestFlight
groups or store submission are part of this change.

Apply only migration 0096 through the numbered runner after a confirmed backup
and all release gates. Deploy worker first, then API at the same verified commit.
Release the updated client only after the server capability is available.
Neither environment is deployed by this document.

Rollback plan: retain the additive schema and redeploy the previously verified
worker/API pair, worker first. Do not remove columns, rewrite the checksum
ledger, or issue data cleanup. Older code ignores the nullable column. Pending
new-client attempts may then receive the legacy rejection and require sign-in;
an older client also cannot interpret a pending recovery proof. A preview
rollback drill must measure this behavior before production approval. Writing
this plan and CI's synthetic recovery exercise do **not** establish that the
preview rollback drill or production backup gate has passed.

Remaining limits: recovery ends if the immediate successor is rotated, revoked
or expires, or its predecessor is removed by existing retention. Web credentials
remain memory-only. Secure-store operations are serialized within one runtime;
there is no cross-process compare-and-swap guarantee. A concurrently persisted
different successor retains the existing legacy 409/adopt path. No migration,
real-user request, message or device notification was executed on a hosted
environment to develop this repair.
