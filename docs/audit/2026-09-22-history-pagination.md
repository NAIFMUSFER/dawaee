# F10: Filter history before the limit and consume every page

The history endpoint previously limited database rows before filtering derived status, hiding older matching doses. The mobile calendar also treated the first 500 rows as the whole selected range.

Status filtering now uses the same terminal/missed/snoozed/upcoming/notified precedence as the displayed dose status, inside the SQL query before LIMIT. Each page is ordered by scheduled time and ID descending. A validated cursor preserves the database timestamp precision and is bound to the profile/date/medication/status/recorded scope. Every page repeats authorization and RLS. The response includes nextCursor; the mobile client carries it in request metadata rather than platform-visible URLs.

The calendar accumulates pages before committing the result. Failure on a later page does not publish a partial calendar. Profile, query and unmount guards are checked after each response. Existing consumers requesting a small recent-dose limit remain bounded; the complete history screen follows cursors.

Three controlled screen cases failed on the previous implementation. All 59 targeted screen/profile/cursor/transport tests pass after the repair. Workspace and mobile TypeScript, build, changed-file ESLint and diff checks pass. The new PostgreSQL integration suite seeds over 1000 doses and checks pre-limit filtering, derived-status equivalence, equal-time pagination, malformed/scope-mismatched cursors and cross-account denial. Its result must be verified in full CI; PostgreSQL is unavailable locally.

Pages are live reads, not an immutable database snapshot. The API documentation now states that concurrent clinical changes require refreshing the history. Physical-device acceptance remains separate.
