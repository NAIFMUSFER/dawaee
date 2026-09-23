# Native registration and phone invitation recovery

User acceptance of iOS 0.1.0 (12) confirmed SMS delivery through Firebase, with two remaining journeys: collect email and phone separately during registration, and show a phone-addressed caregiver invitation after mailbox sign-in and phone proof.

## Root cause and changes

`pending_caregiver_invitation_previews()` only enumerated `pending_email_invitations()`. An exact verified phone recipient could redeem a retained link but could not discover their invitation after the QR opened another browser or after normal sign-in. Migration 0100 enumerates both verified recipient identities and retains the existing preview, expiry, archived/self, and explicit reviewed acceptance checks. It neither backfills identities nor activates existing invitations. A valid phone invitation opened before any phone is linked requests proof without disclosing the patient or target number.

Native signup now presents separate email and phone fields. The phone is a device-only SecureStore contact draft, scoped to the normalized email and expiring after 24 hours; it is not sent to legacy `/auth/register`, reserved, or marked verified. Mailbox ownership and account/password creation still happen through the email link. On the first sign-in on that device with the same verified email, SMS verification opens inline with the number already filled. The freshly supplied password is reused only in mounted component memory for the existing proof-first link endpoint. Passwords, Firebase tokens, and invitation tokens are not put in the contact draft or URL. A different account cannot consume the draft. Browser signup remains mailbox-only because browser phone proof is not configured.

Sign-in exposes explicit email/phone keyboard choices; both continue to use the existing identifier login endpoint. Phone verification from Settings returns to Family to reload incoming invitations. Network failures in discovery now show a retry instead of a silently empty list. A committed phone link remains successful when a subsequent profile refresh fails.

## Verification and rollout gates

Focused tests passed for SQL/RLS recipient discovery and reviewed acceptance, native signup/sign-in continuation, mailbox isolation, secure draft expiry, phone proof lifecycle and invitation consent. Full mobile regressions and repository CI results are recorded with the release PR. Test fixtures use synthetic identities and do not send real SMS.

Before production: all required CI on the candidate, refresh encrypted production backup, rehearse migration 0100 and compatibility with the installed build against an isolated restore, then apply through the numbered runner and deploy the tested server revision. Existing iOS 12 can discover verified-phone invitations after the server/database update; the new registration form requires a new native build. Keep manual deployment settings. Do not treat local unit tests as native device acceptance or claim the updated IPA has been distributed until Apple confirms it.

Rollback: preserve the additive schema and deploy the prior server/mobile source as needed; the new read-only discovery function remains compatible with current API 36a910f. No user records or verification proofs are deleted. Reverting the discovery function would reintroduce missing phone invitations and must not happen incidentally.
