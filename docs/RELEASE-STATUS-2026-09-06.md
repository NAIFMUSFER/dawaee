# Dawaee release-candidate status — 2026-09-06

This is a status pointer, not authorization to mutate production.

## Code and build gates

- Expo SDK 55 / React Native 0.83.10 / React 19.2.0.
- PostgreSQL 16 + 17 CI lanes exercise a realistic non-superuser migration owner, RLS probe, managed-Postgres smoke, unit/integration tests, and mobile typecheck.
- Android and iOS production Metro exports are CI gates.
- Production Docker image build and container security checks are CI gates.
- Dependency audit gate is enforced.
- Security workflow runs CodeQL v4, Gitleaks, and Trivy.
- CI/security GitHub Actions are pinned to immutable commit SHAs.
- Production Node base image is pinned to the verified `node:22-bookworm-slim` manifest digest `sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`.

## Release controls still open

Production release remains blocked until all items in GitHub issue #3 are closed. In particular: protect `main`, disable Render auto-deploy on all Dawaee service definitions, verify the production database identity and backup, run migration preflight/rehearsal, then perform the controlled worker-first/API-last rollout.

Mobile store submission remains blocked on GitHub issue #2: signed EAS preview builds and real Android/iPhone smoke testing.

The production release procedure is `docs/PRODUCTION-RELEASE-RUNBOOK.md`. It currently expects 11 pending migrations, `0020` through `0030`.
