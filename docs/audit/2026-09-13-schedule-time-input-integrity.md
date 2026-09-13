# Schedule time-list integrity — 2026-09-13

Base: `f45e59e4991049c3c94b434247925cbbd9791c87` on PR #14.
No merge, production write or deployment; not release approval.

## Proven defect

At the base, `apps/mobile/app/medication/schedule.tsx:190` computes `sortedTimes` by filtering out every invalid time. `buildRule()` at lines 192–220 accepts any nonempty remaining list for `fixed_times`, `days_of_week` and `cycle`. Save at lines 281–325 sends that filtered rule, even when another visible time field is incomplete or invalid.

The actual screen was executed with its checked-in request hook and controlled-I/O harness. With one time `19:47` and a second `25:00`, Save called the synthetic POST/PATCH boundary instead of rejecting the draft. The same defect reproduced with minute `12:60`, partial `1`, and an empty added row, in all three time-list rule kinds and both create and successfully hydrated edit modes. This proves silently changed client intent, not that any real user's medication schedule was changed or that a server authorization check was bypassed.

The API contract in `packages/shared/src/contracts.ts:203–228` validates only the submitted time array. It cannot recover a time the client omitted. Server validation and high-risk confirmation are intentionally unchanged.

## Minimal change

Replace the one filtering expression with an all-or-nothing time list: retain and sort all entered times only when every row is valid; otherwise return an empty derived list. Existing `buildRule()` validation then rejects the draft and suppresses its partial preview. Preserve the original input rows for correction or explicit removal. Hidden time-list fields do not block interval or as-needed rules. No API, schema, authorization, route-intent, hydration or dependency changes.

## Executed evidence

Selected connector-fetched source files were reconstructed locally and Git-blob verified before testing:

- schedule screen: `3274dbd676c588f6df63e764626ead3ce939ef7e`
- unchanged request hook: `88a0f03fc2dca8648e57a311ec3a7b5bd9af2b99`
- unchanged harness: `1d5bc90806080adb8a3a2108d0ba9acf055edefc`
- existing hydration regression: `26d0814b74a40f230c093424663311bbfdb8cc61`

The new 35-case Node suite was written before the runtime change: **8 PASS / 27 FAIL before**, **35 PASS / 0 FAIL after**. It covers invalid hours/minutes, partial and blank rows in create/edit modes; corrections; explicit removal; valid `00:00` and `23:59`; preserving edit identity; and switching to interval/as-needed rules. The 12 existing schedule hydration/race/confirmation/retry cases also pass against the patched screen: **47/47 combined**, no skipped/cancelled cases. The existing suite and shared harness are not modified.

```sh
node --test --test-reporter=tap apps/mobile/test/schedule-time-input-integrity.cjs
node --test --test-reporter=tap apps/mobile/test/schedule-edit-load-safety.cjs apps/mobile/test/schedule-time-input-integrity.cjs
```

Local execution used Node 22.16.0 and preinstalled TypeScript 5.8.3 through `TYPESCRIPT_PATH`. Only selected exact source files were available locally; network DNS prevented a full clone/install. No full-workspace typecheck/Vitest/PostgreSQL, browser E2E or native-device pass is claimed. The new Vitest wrapper runs the same bounded shell-free Node command in normal CI using the repository's dependencies. Full exact-head CI and security gates remain required after integration.
