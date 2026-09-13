# CI PostgreSQL setup blocked by an unrelated repository

Baseline head: `3af44db439b02350b6306d8f296ff9804d5582b7`, workflow blob `667fc594cbeb43d21b3810d4fc078d35ae625b67` (12,458 bytes). Audit branch only, PR #14 DRAFT; no production/configuration write or deployment.

## Actual operational evidence before editing

CI274 / run34383842297: both verify16 and verify17 fail at `Install PostgreSQL client matching the server`, before npm install, migrations or unit/integration tests. Job102575008485 logs at 2026-09-09 17:36:00 UTC identify `apt-get update` fetching the preinstalled runner's unrelated Google Chrome repository and rejecting its Packages index with `Hash Sum mismatch` (exit100): expected SHA256 `233e56de019b57db89238fa7bcc3647718dbbea3a40c2dc1c633a8c8952aa9e9`, received `bc1428ab27c6d76ee9bb76de07f1ded0ddb4aaabd958fc72855634ef5894a4b3`.

The PostgreSQL17 service is healthy in that log. This failure is infrastructure setup, NOT evidence the new Today regressions or database matrix failed their assertions: those steps were skipped. Parent CI273's attempt3/job102574261519 has the identical Chrome-index failure at 17:34 UTC, so merely rerunning repeatedly has not resolved it. Parent verify16 had passed; do not combine a parent pass with a newer-head skipped test.

## Minimal correction and trust boundary

Limit this one `apt-get update` invocation to the already-configured, official signed PGDG source with Dir::Etc::sourcelist and sourceparts. Keep APT::Get::List-Cleanup=0 so cached indexes for Ubuntu dependency resolution are retained. No system source is deleted or rewritten beyond the existing PGDG setup; the explicit client major, signing-key download, signed-by, package verification, fail-fast shell, both PostgreSQL versions, test command, RLS ownership checks, timeouts and workflow permissions stay unchanged.

The corrected YAML is semantically identical outside that install step. Workflow correction: five added / one removed line. Corrected blob `ecc94959f8b305a985966bd67afb080a513e74f6` (12,815 bytes). No `allow-unauthenticated`, insecure repository, digest bypass or ignored-error option is introduced. Hash mismatch for a REQUIRED source still fails; this change simply does not fetch an unrelated source in the first place.

Primary documentation consulted: https://manpages.debian.org/testing/apt/apt-get.8.en.html (SourceList/SourceParts, List-Cleanup, exit100 and command options), and https://wiki.postgresql.org/wiki/Apt (official PGDG signed-source and explicit-client installation). A local real `apt-get --print-uris update` parser probe with isolated temporary source/list directories selected both fake-configured sources before scoping and only PGDG after. It made NO remote requests or package changes and is not signature-verification/install evidence.

## Regression evidence and limits

Seven permanent tests execute the exact extracted workflow Bash block with controlled external-command stubs. Two major-version scope scenarios failed before; a third downstream install-error control was also blocked earlier at the broad refresh. Four controls passed. After: 7/7 pass with the same callbacks. Required-index failure, key download failure and install failure still stop the script before reporting success. Local execution uses a registration/assertion adapter, NOT the Vitest engine. Native apt download/authentication, package installation and full project tests must independently pass in actual CI on this head.

No prior tests were removed or weakened. The mobile offline correction remains in the parent. This CI change does not approve a release, assert handset delivery, or close the remaining full E2E audit.
