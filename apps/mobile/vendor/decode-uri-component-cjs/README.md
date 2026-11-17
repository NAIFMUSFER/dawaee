# Patched URI decoder compatibility adapter

Expo Router and React Navigation still use CommonJS `query-string@7`.
The security fixes for GHSA-vcc3-ghjq-m6fr and GHSA-qr28-fpjm-wq7f are in
ESM-only `decode-uri-component@0.5.1`. A direct version override breaks the
callable CommonJS export expected by those consumers.

This adapter exports the unmodified upstream default function. The dependency
is an npm alias pinned to the real upstream package, so its provenance,
integrity and future vulnerability advisories remain visible to npm audit.
No decoder code is copied and no advisory is suppressed. Node 22 and Metro
both support the ESM dependency; exercise both query-string and Expo export
when changing the pin. Remove this adapter when the navigation dependency
chain consumes a patched decoder without it.
