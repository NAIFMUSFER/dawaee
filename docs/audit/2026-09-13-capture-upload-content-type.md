# Capture upload content-type integrity — 2026-09-13

## Baseline

PR #14 / `audit/e2e-red-white-black-2026-09-09`, baseline
`b5dac800fb36338963b931dc022dd3baeef0bf91`. CI #855 and Security #856 were
confirmed green on that exact SHA before this audit surface was changed.

## Finding

The image picker already returns an optional `mimeType`, but the capture screen
passed only the asset URI into the upload path. When React Native's URI-backed
`Blob.type` was empty, the screen unconditionally declared `image/jpeg`.

The upload API deliberately requires declared MIME to match the stored image's
magic bytes during finalize. Therefore a valid PNG, WebP or HEIC selected from
the library could receive a JPEG lease and then be rejected as a content-type
mismatch. Weakening server sniffing would be unsafe; the client must preserve
its available picker metadata instead.

## Correction

The capture screen now resolves content type in this order:

1. an allowed non-empty `Blob.type`;
2. an allowed picker `mimeType` when the blob has no usable MIME;
3. the existing JPEG fallback only when neither source reports a type, preserving
   the Expo Camera default-JPEG path.

An explicit unsupported or conflicting reported type fails closed before an
upload lease is requested. The server allow-list and byte-sniffing contract are
unchanged.

## Regression coverage

`capture-upload-content-type.cjs` executes the checked-in TSX through the existing
controlled-I/O screen harness. Six cases cover empty Blob MIME with PNG/WebP/HEIC
picker metadata, allowed Blob MIME without picker metadata, unsupported GIF, and
non-image `application/octet-stream`. The Vitest wrapper adds the suite to the
normal root CI collection.

This is deterministic screen-boundary evidence, not physical-device acceptance.
The remaining OCR/object-storage release blocker still requires real provider and
device acceptance; this change does not close it.
