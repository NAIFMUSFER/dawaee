# N10: Failed requests must not imply empty clinical data

Today and Medications previously handled transport failures and HTTP 503, but silently fell through on HTTP 429, HTTP 500, and unexpected response errors. On first load the initial empty state then falsely claimed there were no medications or doses.

Both screens now expose their existing error/retry state for every non-transport load failure. Existing data, transport-offline behavior, cached schedule fallback, and request/profile scope guards remain intact. A successful retry clears the error and restores the clinical display.

Validation executes the checked-in screens in the existing controlled React/host harness. Six new cases failed before the fix. All 52 load-error and profile-screen isolation tests now pass, including 429/500/503 failures followed by successful retry on both screens and unexpected failures. Mobile TypeScript, changed-file ESLint, and git diff checks pass. A stale ignored web bundle blocked the initial local setup; moving that old artifact outside the export directory allowed the normal build and tests to complete.

This is controlled screen behavior evidence, not physical-device or browser E2E acceptance. Full CI is required before candidate promotion.
