# CI security gates

What CI checks, why each check exists, and what to do when one goes red.

Everything in the BLOCKING column fails the job. Nothing here is suppressed
with `|| true` or `continue-on-error` except the two rows that say
**informational**, and both say why.

## The gates

| GATE | WHY | COMMAND | BLOCKING | FAILURE RESPONSE |
|---|---|---|---|---|
| Clean install (root) | A build from a resolved lockfile, not from whatever npm feels like today | `npm ci` | yes | Lockfile drift. Commit the lockfile the install produces; do not switch to `npm install` |
| Clean install (mobile) | `apps/mobile` is not a workspace member and has its own lockfile | `npm ci --legacy-peer-deps` | yes | Same. The peer-deps flag is Expo's requirement, not a workaround |
| Lint | | `npx eslint .` | yes | Fix it |
| Typecheck | `noUncheckedIndexedAccess` is a safety property, not style | `npm run typecheck` | yes | Fix it |
| Mobile typecheck | | `npx tsc --noEmit` in `apps/mobile` | yes | Fix it |
| Full test suite | Every security suite from P1–P15 runs here | `npm test` | yes | See "when a security suite fails" below |
| Migrations, fresh DB | Production applies migrations as a database owner, never a superuser. That difference has hidden two deploy-only failures | `./scripts/migrate.sh` on a `ci_owner`-owned database | yes | Reproduce locally with a non-superuser owner |
| Migrations, replayed | A second run must be a no-op. Migrations are immutable once shipped | `./scripts/migrate.sh` twice, second must report *no pending migrations* | yes | A migration is not idempotent, or the ledger checksum changed. **Never edit a shipped migration** — add a new one |
| RLS probe | Patient A must not reach Patient B. A single `FAIL` line is a release blocker | `psql -f db/seed/rls_probe.sql` | yes | Stop. This is the boundary the product rests on |
| RLS probe on the owned DB | RLS behaves differently under an owner than under a superuser | same, against `dawaee_ci` | yes | As above |
| Dependency gate | See "the dependency gate" below | `node scripts/audit-gate.mjs --workspace all` | yes | Read the output; it names the module, the advisory and whether a fix exists |
| Production image builds | The image that deploys, from the real base | `docker build --target runtime` | yes | Fix the Dockerfile |
| Container properties | A Dockerfile that says `USER dawaee` and an image that runs as uid 1001 are different claims | `./scripts/container-checks.sh` | yes | The script names which property failed |
| CodeQL | | `github/codeql-action` | yes | Triage the alert; do not dismiss without a written reason |
| Secret scan | A credential removed in a later commit is still in the pack | `gitleaks --redact` | yes | **Rotate first, then remove.** Deleting the commit does not un-leak it |
| Container CVE scan (report) | The base OS, which `npm audit` says nothing about | Trivy, SARIF upload | no — reporting | Read the SARIF in the security tab |
| Container CVE scan (gate) | A fixable CRITICAL means a rebuild would fix it and nobody rebuilt | Trivy, `ignore-unfixed: true` | yes | Rebuild on a current base. If unfixable, it is triage, not a wall |
| Package signatures | P14 recorded this NOT RUN because Sigstore was unreachable from the audit sandbox | `npm audit signatures` | yes, weekly | A signature failure is a supply-chain event. Do not retry until green |
| Expo compatibility | | `npx expo-doctor`, `npx expo install --check` | **no — informational** | expo.dev being down and your dependencies drifting must not be the same signal. The dependency gate is the blocking one |
| Base image digest | Recorded per run so the base a release was built on is recoverable | `docker image inspect`, `/etc/os-release` | **no — informational** | Recording only; pinning is an open decision, see below |

## The dependency gate

`npm audit` on its own cannot be the gate here, and the reason is worth
writing down because the obvious fixes are both wrong.

Failing on every advisory does not work. Measured on this tree, `npm audit` in
`apps/mobile` reports **33 entries including one critical and eleven high** —
and `--omit=dev` changes nothing, because `expo` is a runtime dependency and
the entire CLI and Metro bundler hang beneath it. A gate that fails on all of
that fails on every commit, and a gate that fails on every commit is switched
off within a week. That is how repositories end up with `npm audit || true`.

Failing on nothing is worse, for the obvious reason.

So the gate does two things npm does not.

**It reports advisory roots, not aggregates.** npm attributes a vulnerability
to every ancestor of the affected package as well as to the package itself, so
one leaf advisory appears many times — `expo` and `react-native` both show as
HIGH purely because something far beneath them is. The real figure is **six
roots**, not thirty-three.

**It separates the bundling boundary from npm's dev/production split**, because
they are not the same boundary. `tar`, `postcss`, Metro and `@expo/cli` run on
a developer's machine or a build server; none of them is bundled into the
binary a patient installs. An arbitrary-file-write in `tar` reached through
`@expo/cli` is a build-server risk, not a patient risk, and holding it to the
same threshold as something in the app's own import graph is what makes the
noise. They are held to different thresholds — separated, not ignored.

| | runtime-reachable | build toolchain |
|---|---|---|
| threshold | fails at **high** | fails at **critical** |
| current roots | 1 | 5 |

Every finding at or above its threshold must have an entry in `BASELINE` in
`scripts/audit-gate.mjs`, carrying the advisory ids, the severity accepted, the
reason, the date, a review date, and the condition that ends the exception.
A package name on a permanent allowlist is not an accepted risk; it is an
unexamined one.

Three rules keep the baseline honest, and each fails the build:

- **An entry past its `reviewBy` date.** The exception is not revoked
  automatically — that would break a build for a reason unrelated to security —
  it is escalated to a person who has to re-read and re-date it.
- **An entry that no longer matches any advisory.** An exception that outlives
  its vulnerability has stopped describing reality.
- **A new advisory id on an already-excepted module, or a severity increase.**
  The exception covered what was reviewed, not whatever arrives later.

### Current exceptions

All six are recorded in `scripts/audit-gate.mjs` with full reasoning. In
summary, accepted 2026-09-06, review due 2026-12-06:

| module | severity | reach | why accepted |
|---|---|---|---|
| `tar` | critical | build (`@expo/cli` → `cacache`) | Extracts archives on the build machine. Fixed only by `expo@57`, a major SDK upgrade |
| `postcss` | high | build (`@expo/metro-config`) | Processes CSS at bundle time; this app ships no CSS |
| `image-size` | high | build (`metro`) | Reads dimensions of assets committed to this repository, never user input |
| `@xmldom/xmldom` | high | build (`@expo/plist`) | Parses this repository's own Info.plist and AndroidManifest during prebuild |
| `uuid` | moderate | build (Expo CLI telemetry, `xcode`) | Below threshold; listed so the review is deliberate |
| `decode-uri-component` | moderate | **runtime** (`expo-router` → `query-string`) | The one runtime-reachable root. DoS via a malformed percent-encoded deep link; worst case is the app becoming unresponsive, with no data exposure. Carried from P14 |

## When a security suite fails

`npm test` runs every suite from P1–P15, and
`apps/api/test/release-gates.test.ts` fails if any of them has been deleted or
if a named release-critical behaviour is no longer covered by a collected test.

A red security suite is not a flaky test to retry. In order:

1. Read which assertion failed. They are written to say what the property is.
2. Reproduce it locally against PostgreSQL 17 — CI runs 17 and 16, and a
   failure on 17 only is a production failure.
3. If the assertion is genuinely wrong, change it **and say so in the commit
   message**, with what was measured. Do not delete it.
4. If the assertion is right, the change under test is the problem.

Deleting a suite to make CI green is caught by the release-gate manifest. That
is the whole reason it exists.

## Known limitations

Recorded rather than hidden. Each is carried to P17/P18.

| item | state | why |
|---|---|---|
| Actual GitHub Actions run | **NOT RUN** | The audit sandbox has no egress to GitHub. Every gate above is executed locally where it can be; the workflow YAML is verified by test, not by a run |
| Third-party action SHA pinning | **BLOCKED** | `api.github.com` returns 403 from the audit environment, so no SHA could be resolved. Fabricating one would be worse than the mutable tag. Actions currently pin to tags (`@v4`, `@v3`, `@v6`) |
| Base image digest pin | **OPEN DECISION** | Recorded per run rather than pinned. A digest with no update mechanism eventually freezes security fixes, so pinning needs an owner for the refresh — not just a line in the Dockerfile |
| PostgreSQL 17 locally | **BLOCKED** | `apt.postgresql.org` returns 403 from the audit environment. The CI matrix runs 17; the local suite runs 16 |
| Real Docker production build | **BLOCKED locally** | No Docker daemon and no registry egress. `scripts/container-checks.sh` runs in CI against the real image |
| Branch protection / required checks | **NOT VERIFIED** | A repository setting, not a file. Green CI is only a gate if GitHub requires it before merge — see below |
| Render deploy branch | **NOT VERIFIED** | `render.yaml` sets `autoDeployTrigger: commit` for both services; WHICH branch each service tracks is a dashboard setting |
| GitHub secret scanning / push protection | **NOT VERIFIED** | Repository settings. The `gitleaks` job covers the same ground in a place this audit can see |

### The two that matter most

**Branch protection.** Everything above assumes a red check prevents a merge.
If `main` has no required status checks, CI is advisory and a failing security
gate can be merged past. Verify: Settings → Branches → branch protection rules
for `main`, with `verify`, `docker`, `dependencies`, `codeql` and `secrets`
required, and administrators included.

**The deploy branch.** `render.yaml` deploys on commit. If the tracked branch
is anything other than `main`, or if `main` is not protected, an unreviewed
commit reaches patients. Verify both services in the Render dashboard.

Neither can be checked from the repository, and neither should be assumed.
