# Verifying TRUST_PROXY_HOPS against the real deployment

`TRUST_PROXY_HOPS` is a fact about the network in front of the service, not
about the code, and it cannot be verified from the repository. It is currently
**1**, and that value is **unverified against production**.

Both ways of being wrong are silent.

**Too low** — a value the client wrote becomes `req.ip`. Every address-keyed
limit is then one header away from meaningless. This is the state the service
was in before the setting existed: measured, 14 of 14 registrations from one
address were allowed simply by varying `X-Forwarded-For`.

**Too high** — the app walks past the real client and lands on the proxy's own
address. Every user on earth then shares one rate-limit bucket and one `ipHash`
in the audit trail. Nothing errors; the limits start refusing everybody at once.

## Why this is open

Two sources disagree about which end of the chain Render fills.

- A Render staff comment on the *Send the correct X_FORWARDED_FOR* feature
  request (marked complete, May 2021) says "we set the first IP in the list to
  the real client IP" — which would make the **leftmost** entry authoritative.
- A Render community thread on reading client IPs in Node describes the proxy as
  **appending** rather than replacing, with the working answer being to take the
  **second-to-last** entry.

Those imply different hop counts. The audit could not settle it: the sandbox has
no egress to `*.onrender.com`, so no request was ever made against the running
service. Do not resolve this from documentation — measure it.

## What is not at risk while it is open

The controls that stop credential attacks are keyed by **identifier** as well as
by address (`apps/api/src/auth/rate-budget.ts`). A wrong hop count degrades the
address-keyed layer; it does not remove the per-account limit, the per-phone OTP
issuance budget, or the account lockout. That is why the hop count is a
correctness problem to close rather than an open door.

## The check

Run it once per environment, and again after any change to domains, CDN or
ingress.

1. **Deploy is live and healthy**

   ```
   curl -si https://<service>.onrender.com/health | head -1
   ```

2. **Send a request carrying a forged chain.** The value below is documentation
   IP space (RFC 5737) so it can never collide with a real client.

   ```
   curl -s -o /dev/null \
     -H 'X-Forwarded-For: 203.0.113.1, 203.0.113.2, 203.0.113.3' \
     https://<service>.onrender.com/health
   ```

3. **Read what the app believed.** The request log line for that request carries
   `req.remoteAddress`. In the Render dashboard, or:

   ```
   render logs --resources <service-id> --limit 50 --text remoteAddress
   ```

4. **Interpret.**

   | `remoteAddress` shows | Meaning | Action |
   |---|---|---|
   | `203.0.113.3` | The app trusts the entry nearest itself and Render appended nothing after the forged chain | **Client can spoof.** The hop count is too low for this topology — raise it only once you know how many entries Render adds |
   | `203.0.113.1` | The app trusts the leftmost, client-written entry | **Client can spoof.** Configuration is wrong; do not ship |
   | your own public address | Render appended it and the app is reading the right end | **Correct.** `TRUST_PROXY_HOPS=1` is right |
   | a `10.x`/`172.16-31.x`/`192.168.x` address | The app walked past the client onto Render's own proxy | **Too high.** Lower it; every client is currently sharing one bucket |

   The application also warns on its own for the last case — once per process,
   `client address resolves to a private range`, without logging the address.
   Its absence is not proof of correctness; the first two rows produce no
   warning.

5. **Repeat against every public path** that reaches the service: the
   `onrender.com` URL and any custom domain. If a CDN is ever put in front,
   there is one more hop on that path and only that path — a single hop count
   cannot then be right for both, and the service must stop accepting requests
   that do not come through the CDN.

Add no permanent diagnostic endpoint for this. The existing request log already
carries the value, and an endpoint that echoes what the server believes about a
caller is a reconnaissance tool left switched on.

## Direct-access note

`dawaee-api` currently has `ipAllowList: 0.0.0.0/0` and no custom domain, so the
`onrender.com` URL is the only path in and there is nothing to bypass. That
changes the moment a CDN is introduced: anything enforced only at the edge
becomes optional, because the origin remains reachable directly.
