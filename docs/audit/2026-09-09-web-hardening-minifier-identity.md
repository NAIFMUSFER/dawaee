# Build hardening: bind structure, not minifier-local names

Baseline: `4fecb9d256d10b9b727be33ece245b7349a4c555`, Draft PR #14.
That commit was already present when this continuation began; preserve its CSP
sidecar, build-from-source route test, ignored generated output and protections.

## Evidence before editing

Security #286 run `34391731191`, container job `102601409174`, failed the real
Docker web stage at 2026-09-09T18:54:31Z, after Expo exported 961 modules:

```
web hardening drift: expected 1 ExpoLinking.addListener message handler snippet(s), found 0
```

The failed upload of trivy.sarif is secondary: the image never built, so Trivy
never ran. A successful CodeQL execution does not make this security run green.

Locally reconstructed the exact Python blob
`30f12e6a7881b50eb0d785bbf29e7deaae2c0ef8` and test blob
`e8cce39d06b2d50b5b675a5887505fc79aa62ea6`; Git blob hashes verified.
The original three tests passed, but each of four alpha-equivalent fixtures
(renamed locals, double quotes, both, dollar/underscore locals) failed the same
first hardening check. This independently proves sensitivity to spelling rather
than semantics. The actual failing CI entry bytes were not available locally;
only a subsequent real build can prove the correction accepts that exact export.

## Bounded correction

Match the four known structures with captured identifiers and repeated-name
backreferences. Permit only identifier/quote spelling changes; require the same
forwarded event, registered/saved handler and saved listener identities. Keep
exactly one match for each structure and fail closed on missing, extra or
semantically changed structures. Do not use a generic callback rewrite, silently
skip hardening, remove listeners, or change CSP/scan policy.

Expand the real-bundler test from three to twenty cases. Four equivalent-input
cases are RED on the baseline: 16 PASS / 4 FAIL; corrected result: 20/20 PASS.
Positive cases execute transformed JS and check rejected foreign/null/lookalike/
wrong-port origins, accepted same-origin signals, literal percent and Arabic query
values, matching CSP hash and unchanged lazy chunk. Thirteen negative cases cover
missing/duplicate structures and event/listener/handler identity drift. The prior
three test intents remain.

Local execution used Node 22.16.0, real Python subprocesses and Node assertions
via a Vitest registration/expect adapter, NOT the Vitest package. Focused strict
TypeScript checking passed using local declarations for the unavailable Vitest
module; this is not a full workspace typecheck. Python compilation also passed.
No project dependencies, PostgreSQL or Docker were available locally; a public
Git clone failed DNS. Full exact-head CI, real Docker/Expo build, PG16/17,
Gitleaks/Trivy and the separate CodeQL findings gate must still be verified.

No merge, deployment, database/config mutation, provider call or notification
send. Generated output removed by the parent is not proof of a clean rebuilt
bundle scan; generated-code coverage remains a distinct acceptance concern.
