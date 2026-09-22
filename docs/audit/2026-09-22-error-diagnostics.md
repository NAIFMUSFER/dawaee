# Error diagnostic boundary (N1 follow-up)

Six new regression probes failed before this repair: arbitrary error text was
written by both logger serializers and the real PostgreSQL idle-client error
callback, and a cyclic `cause` overflowed the serializer stack. The canary was
plain health-like free text, deliberately outside token/phone/JSON patterns.

The shared stdout serializer now emits only a fixed error category and a
validated SQLSTATE or allowlisted system error code, with bounded causes. It
does not copy messages, stack headers, arbitrary database metadata, constructor
names, or thrown strings/objects. API startup/retry, idle-pool, unhandled
rejection, worker startup/tick/job and housekeeping error paths use that
boundary. Static event names, job names, request correlation and retry numbers
remain available. Losing full error text/stack is an intentional diagnostic
tradeoff; reproducing a fault in an isolated environment is preferable to
writing unknown patient/provider text to production logs.

Local validation: all six probes pass after failing before the fix; workspace
types and targeted ESLint pass. Existing database-backed log tests retain real
SQLSTATE assertions and now explicitly reject message/stack/metadata output.
The complete PostgreSQL CI matrix remains the merge gate.

Startup probes initially exposed two diagnostic compatibility requirements:
missing migration filenames and the TLS refusal marker. A separate startup
boundary retains only migration filenames present in the packaged build and a
fixed TLS diagnostic, never the exception message or certificate path. Two
additional probes verify those useful diagnostics without the free-text canary.

Scope: this hardens error output. `sanitizeOperationalError` still performs
pattern-based filtering for strings persisted to job/provider records; this
change does not establish universal free-text privacy in those records, erase
old logs, or prove the new code has reached production.

The dependency exception documentation also corrects the upstream fixed
version for GHSA-vcc3-ghjq-m6fr to decode-uri-component 0.5.0. The installed
query-string 7.1.3 uses a CommonJS function import, while the fixed package is
ESM. No untested override is installed and the runtime advisory remains open.
Source: https://github.com/SamVerschueren/decode-uri-component/security/advisories/GHSA-vcc3-ghjq-m6fr
