# N3 / N4 — cache key ordering and migration readback

Controlled native-I/O boundaries reproduced concurrent first-use keys,
resurrection after a racing key deletion, reset/write misordering, and removal
of plaintext after a dropped/corrupt/unreadable ciphertext write (6 failed / 1
passed before changes).

Key reads/creation/reset/destruction now serialize per account in the JavaScript
runtime. Key bytes are not cached; subsequent operations still read SecureStore.
Failed operations release the queue. Reset's delete+create sequence is one
operation, and logout's deletion follows an already pending creation.

Plaintext migration now reads the stored envelope back and decrypts those
persisted bytes before deleting its predecessor. Missing, corrupt or failed
readback leaves the original queued data on disk. It does not claim a failed
storage device became durable or that every corrupted cache can auto-recover.

Validation: 108/108 in cache persistence, existing secure-cache and offline queue
race suites; mobile TypeScript, changed-file ESLint and diff check passed.
Tests use real encryption/randomness with controlled storage boundaries. The
serialization is within one JS runtime, not a cross-process/native device lock.
No physical device, application restart on iOS/Android or deployment is claimed.
