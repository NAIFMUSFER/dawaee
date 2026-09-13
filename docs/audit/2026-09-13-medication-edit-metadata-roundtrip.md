# Medication editor metadata loss — 2026-09-13

Base: `77806dbcb10fa2dc0380775f9fedf501ecb49942` (PR #14).
This is not release approval; no production data was changed for reproduction.

## Evidence before changing runtime code

- `apps/api/src/routes/medications.ts:18-37` selects and returns `manufacturer` and `barcode`.
- `apps/mobile/app/medication/edit.tsx:72-88` loads other medication fields into the editor, but leaves both metadata fields at the empty defaults from `emptyDraft`.
- The same editor's `body()` includes both fields on every save, converting empty strings to explicit nulls.
- `apps/api/src/routes/medications.ts:349-390` distinguishes absent PATCH fields from explicit nulls. A present null therefore clears the stored field. The backend behavior is intentional and must not be weakened.

The actual editor and request hook were executed with the repository's existing controlled-I/O screen harness. Copies were verified against Git blob hashes before execution:

- editor: `1e2318df88a6875d8b361a93e8636cb02ebe8d43`
- request hook: `88a0f03fc2dca8648e57a311ec3a7b5bd9af2b99`
- harness: `1d5bc90806080adb8a3a2108d0ba9acf055edefc`

With synthetic existing metadata, both inputs were empty. Editing only notes produced `{ manufacturer: null, barcode: null }` in the captured PATCH payload. This proves the destructive client payload; it does not claim that a real user's records were observed being erased.

## Minimal fix

Populate `manufacturer` and `barcode` in `fromMedication`, preserving strings (including barcode leading zeros) and mapping nullable fields to empty inputs. Add the two nullable metadata members to `MedicationView`, optional for compatibility with partial/older records. No API, database, authorization, navigation, null-clearing, or high-risk confirmation behavior changes.

## Reproduction and regression

From the repository root, after installing the existing dependencies:

```sh
node --test apps/mobile/test/medication-edit-metadata-roundtrip.cjs
```

The Vitest wrapper `medication-edit-metadata-roundtrip.test.ts` runs this same bounded, shell-free command as part of the existing test suite and requires all five cases to pass.

Five scenarios cover loading existing metadata, editing only notes, explicit metadata replacement including leading zeros, deliberate clearing, and null round-trip. Before the fix: **3 PASS / 2 FAIL**. After the fix: **5 PASS / 0 FAIL**, using Node 22 and the actual checked-in screen/hook/harness. No shared harness or pre-existing tests were modified.

These are deterministic screen-boundary tests, not browser/native-device E2E, a live PostgreSQL run, or an external-provider receipt test. Full workspace CI and security gates must still complete on the new commit. The local environment could not resolve GitHub for a full clone; selected connector-fetched files were blob-verified instead, and no local full-workspace pass is claimed.
