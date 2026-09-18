# AlgoPush — Codeforces OAuth exchange backend

AlgoPush's "Connect Codeforces Account" button uses Codeforces' real OpenID
Connect login (announced at https://codeforces.com/blog/entry/145566). That
proves which Codeforces handle you own — it does not grant access to
submission source code, which AlgoPush still fetches separately from your
own logged-in browser session.

Codeforces' token endpoint requires a client secret
(`token_endpoint_auth_methods_supported: ["client_secret_post"]` — see
`https://codeforces.com/.well-known/openid-configuration`), so the
authorization-code → token exchange can never happen inside the extension
itself: any secret shipped in extension code is readable by anyone who
installs it. This is a small Cloudflare Worker that holds that secret,
performs the exchange, verifies the signed ID token, and returns only the
plain `{ handle, rating, avatar }` claims to the extension — never the token
or the secret.

## 1. Register an OAuth app on Codeforces

1. Sign in at [codeforces.com](https://codeforces.com), go to **Settings → API**, and create an OAuth app.
2. Set its **redirect URI** to AlgoPush's fixed extension callback URL:

   ```
   https://oflhjpbehioebeaologailkkfbmleipl.chromiumapp.org/
   ```

   This ID comes from the signing key already committed in this project's
   `manifest.json` (`key` field), so it stays the same every time you load
   the unpacked extension — you don't need to re-register after reloading it.
3. Save the app and copy its **Client ID** and **Client Secret**.

## 2. Deploy the Worker

Requires a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

```bash
cd oauth-backend
npm install
npx wrangler login
npx wrangler secret put CF_CLIENT_ID       # paste the Client ID from step 1
npx wrangler secret put CF_CLIENT_SECRET   # paste the Client Secret from step 1
npm run deploy
```

### Optional secrets

| Secret | Default | What it does |
| :--- | :--- | :--- |
| `CF_CLIENT_ID` | unset | When set, only codes for this one client are exchanged. Set it. |
| `CF_REDIRECT_URI` | the extension's `chromiumapp.org` callback | The `redirect_uri` sent to Codeforces. Pinned server-side — the request body cannot influence it — so a stolen authorization code can't be redeemed against someone else's callback. Only change it in a fork whose extension id differs. |
| `ALLOWED_ORIGINS` | the extension's `chrome-extension://` origin | Comma-separated CORS allowlist. A request carrying no `Origin` at all is still served, because Chrome does not consistently attach one to extension fetches — so treat this as defence in depth, not as the access control. |

### Rate limiting

The exchange endpoint is unauthenticated by necessity, so it is capped at 10
attempts per IP per minute (a real login needs one). Bind a KV namespace to
make that cap hold across isolates — see the commented block in
`wrangler.toml`. Without it the limit still applies, but per-isolate.

## Tests

```bash
npm test
```

Covers the parts that are dangerous to get wrong: signature verification,
`alg: none` and foreign-key rejection, required `exp`, issuer/audience/nonce
checks, the pinned redirect URI, the CORS allowlist and the rate limit. It runs
against a mocked Codeforces, so it needs no secrets and no network.

`wrangler deploy` prints the Worker's URL, e.g.
`https://algopush-cf-oauth.<your-subdomain>.workers.dev`. Your exchange
endpoint is that URL plus `/auth/codeforces/exchange`.

## 3. Configure AlgoPush

In the extension's options page, under **Codeforces Account**, paste:

- **OAuth Client ID** — from step 1.
- **OAuth Exchange Backend URL** — `https://algopush-cf-oauth.<your-subdomain>.workers.dev/auth/codeforces/exchange`

Then click **Connect Codeforces Account** and approve on codeforces.com.

## Verifying it works

```bash
curl -i -X POST https://algopush-cf-oauth.<your-subdomain>.workers.dev/auth/codeforces/exchange \
  -H 'Content-Type: application/json' \
  -d '{"code":"bad","clientId":"your-client-id"}'
```

A `502` with a Codeforces-shaped error (not a `500` "misconfigured" or a
`403`) means secrets are set correctly and the Worker is really talking to
Codeforces — a real login from the extension is the only way to get a `200`.

Note that `redirectUri` in that body is ignored: the Worker uses its own
pinned value. It is accepted only so older extension builds keep working.

## Why this can't just be serverless-free

Codeforces' discovery document only advertises `client_secret_post` for the
token endpoint — no PKCE-only / public-client option. Until Codeforces adds
one, some server has to hold the secret. This Worker is the smallest version
of that server: no database, no session state, just "exchange this code,
verify the signature, return the claims."
