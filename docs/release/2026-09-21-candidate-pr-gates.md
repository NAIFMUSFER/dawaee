# Candidate PR verification — F2

The independent audit confirmed that `main` is behind the release candidate,
while PR32 remains a draft. It did **not** establish that the deployed e59f864
had no CI: CI and Security scan both succeeded on that exact head, including
PostgreSQL 16 and 17. The PR base was already permitted by the workflows.

The remaining reproducible gap is a PR targeting another candidate branch:
both CI and Security scan restrict PR **base** branches to main and prepare.
Independent repairs targeting `audit/ios10-evidence-20260920` therefore have no
guarantee of receiving those gates. The two regression cases in
`apps/api/test/candidate-pr-gates.test.ts` fail on the original workflows.

This repair removes only the PR base filters. Both workflows now accept every
PR base and changed path. Checkout still uses the exact PR head. Read-only
defaults, pinned actions, the PG16/17 matrix, both clean-database migration
passes, RLS probes, the full Vitest command, typechecks, lint, dependency gate,
container checks, recovery checks and security scans retain their existing
requirements. The scheduled security audit keeps its existing schedule.

The authoritative repair base for this audit starts at
`audit/ios10-evidence-20260920`, commit
`9bf0a3bc66f025907b1efff5a907e629bb334bed`. A repair PR targets that candidate;
it does not silently promote its contents to main or to a Render branch.
Advance an integration candidate only by a reviewed merge after successful CI,
and repeat all required checks on the resulting integration commit. Preserve
independent branches and their history. Never use matching source trees as a
substitute for exact-commit deployment evidence.

For every release, record the full commit, CI and security run URLs, preview
version/ready and journey evidence, backup confirmation before migrations,
tested rollback, installed-build compatibility and worker-then-API deploy IDs.
If any required production gate is missing, do not deploy production. Keep
production automatic deployment off. Do not sync the old main Blueprint as
an incidental consequence of a CI repair.

Residual F2 work: merging the candidate into main and creating a release tag
are not established by this workflow change. They require successful checks
on the resulting commit and the user's deployment gates. This PR fixes the
candidate verification gap; it is not proof that main, preview and production
already represent one commit.

GitHub trigger semantics: [pull_request event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).
