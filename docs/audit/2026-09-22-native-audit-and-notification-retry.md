# Native audit renewal and notification response retry (N23)

The response listener marked every attempt handled before execution and consumed rejected outcomes. Two controlled cases failed before repair: rejection consumed the native response, and an unexpected failure blocked retry. The listener now separates in-flight and accepted responses, preserves the operation ID/time on retry, and only consumes server/journal acceptance. Duplicate concurrent events cannot dispatch twice or prevent consuming the accepted response. Intent retention is within the current listener lifetime; this does not claim physical-device delivery or durable recovery across every process failure.

52 targeted cases passed; the native mutation suite contains 35 cases. Full PostgreSQL gates and native builds are tracked in the PR.

The old Android UI script relied on retired one-step registration at the hosted preview. The renewed workflow runs the actual API with restricted app database role against disposable PostgreSQL 17 in CI. A guarded stdin fixture helper seeds only synthetic example.invalid identities through the existing auth-plane operation; normal HTTP login and UI actions remain real. No remote fixture endpoint exists. The installed emulator uses a separate app identity and ADB loopback forwarding; HTTP is permitted only in this explicitly guarded CI configuration. Hosted audit APKs retain HTTPS.

The Android interaction audit records small-screen and 200% font time selection, hardware Back/cancel, save/readback, confirm/undo/retake and stock checks. Passing it is Android emulator evidence, not a physical phone or real SMS/Push delivery. The audit-ios-simulator EAS profile enables an unsigned simulator build, not TestFlight distribution.
