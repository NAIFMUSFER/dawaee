# Refill retries and schedule date intent

Refill had no stable request identity, and a second tap before React rendered busy state could submit twice. Schedule Save silently replaced invalid start dates with today and invalid end dates with null.

The stock screen now synchronously excludes overlapping mutations and retains a request identity across ambiguous same-input retries until success. API refill authorization precedes replay lookup. The medication lifecycle lock serializes existing and first-stock creation; the new 0099 migration stores the identity, normalized request hash and original balance/forecast in the same transaction as refill and ledger writes. Changed input with the same identity is a conflict. Old clients without a key remain compatible but cannot gain retry idempotency.

Schedule Save rejects absent/invalid/reversed dates without modifying the draft. It never guesses a replacement clinical date.

Before fixes: seven screen regressions failed. After fixes: all 40 stock/schedule screen cases passed. These exercise actual TSX through controlled I/O, not physical devices. Five PostgreSQL cases cover concurrent duplicate requests, mismatched reuse, original-response replay after a later action, first-stock creation, and unauthorized replay; see CI on this commit. Root/mobile type checks and targeted lint run locally.

Limits: identity survives retries within the current keyed stock screen lifetime, not uninstall/process loss or a manually recreated intent. Manual stock delta writes and other creation endpoints are not claimed universally idempotent. iOS12/Android7 source version markers are prepared; a completed build is separate evidence. No production migration or store distribution is performed by this source change.
