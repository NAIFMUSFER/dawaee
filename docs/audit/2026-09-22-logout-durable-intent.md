# N24: Persist logout intent when credential deletion fails

Previously, failed secure or legacy deletion was swallowed. A later process could read the undeleted secure session or migrate the old plaintext pair and become signed in again.

Native logout now writes and reads back a non-secret signed-out marker before attempting both cleanup paths. Startup fails closed when that marker exists or cannot be read. A marked startup retries credential cleanup but never restores the old session. A new secure session is read back before the marker is removed, so a failed or silently dropped sign-in write cannot restore an old session. Web remains memory-only. The plaintext storage inventory explicitly permits only the constant logout marker, with no identity, health data, or credentials.

Four regressions failed before the change: secure deletion failure across a fresh module, legacy deletion failure, unreadable logout decision, and a failed new session write. Seven new tests also cover silently dropped marker/session writes and retrying cleanup after storage recovery. All 90 targeted token/session/refresh/provider-transition tests pass. Mobile TypeScript, changed-file ESLint and diff checks pass.

Limits: this prevents application restoration of undeleted credentials; it is not proof that failed physical deletion succeeded or that an offline server session was revoked. If all local storage is unwritable, no durable logout decision can be guaranteed; the storage API reports marker failure while still attempting cleanup. Device acceptance and full CI remain required before release approval.
