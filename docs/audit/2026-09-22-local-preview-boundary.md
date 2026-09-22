# N21 — local preview server boundaries

Three HTTP regression cases failed against the original `scripts/serve-web.mjs`:
malformed percent encoding terminated the process; a symlink in the export root
served an outside file; and a missing SPA fallback terminated the process.

The loopback-only helper now rejects malformed/NUL paths with 400, verifies
lexical and canonical path containment, refuses outside symlinks with 403, and
handles missing files/stream errors without an unhandled process error. Nested
indexes, ordinary assets and SPA deep links remain supported.

All three HTTP cases pass after the fix, alongside changed-file ESLint and API
TypeScript. Fixtures contain only synthetic files in temporary directories and
are cleaned after each case. This is a local development helper finding, not
proof of exposure in the hosted production API. It does not protect against a
trusted local filesystem writer swapping paths between checks and open.
