// AlgoPush's Codeforces OAuth exchange backend.
//
// Codeforces' OIDC token endpoint requires client_secret_post auth (see
// https://codeforces.com/.well-known/openid-configuration), so the
// authorization-code -> token exchange can't happen inside the extension —
// any secret shipped in extension code is readable by anyone who installs
// it. This Worker holds the secret, does the exchange, verifies the signed
// ID token itself, and returns only the plain claims the extension needs
// (handle/rating/avatar) — never the token or the secret.

const EXCHANGE_PATH = '/auth/codeforces/exchange';

const CODEFORCES_TOKEN_URL = 'https://codeforces.com/oauth/token';

// The issuer Codeforces names in its discovery document. Compared with the
// trailing slash normalised away, because issuers are written both ways.
const EXPECTED_ISSUER = 'https://codeforces.com';

// The extension's fixed chrome.identity callback. Pinned here rather than
// taken from the request body: the body is attacker-controlled, and letting a
// caller name its own redirect_uri turns this endpoint into a generic
// code-exchange oracle for the OAuth app whose secret it holds. Overridable
// with the CF_REDIRECT_URI secret for forks with a different extension id.
const DEFAULT_REDIRECT_URI = 'https://oflhjpbehioebeaologailkkfbmleipl.chromiumapp.org/';

// Requests from a browser page carry an Origin; the extension carries its own
// chrome-extension:// origin. Overridable with the ALLOWED_ORIGINS secret
// (comma-separated).
//
// Worth being clear about what this does and does not buy: it stops *browser*
// pages on other origins from driving this endpoint, because the browser
// enforces it. It does nothing against curl, which simply sends no Origin at
// all — and a request with no Origin has to keep working, since Chrome does
// not consistently attach one to extension fetches covered by host
// permissions. The controls that actually matter against a non-browser caller
// are the pinned redirect URI above and the rate limit below.
const DEFAULT_ALLOWED_ORIGINS = ['chrome-extension://oflhjpbehioebeaologailkkfbmleipl'];

// Per-IP cap on exchange attempts. A real login needs exactly one.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Codeforces' token response is small; anything larger is not a login.
const MAX_BODY_BYTES = 4096;

// Tolerance for clock drift between this Worker and Codeforces, in seconds.
const CLOCK_SKEW_SECONDS = 60;

function allowedOrigins(env) {
    if (!env.ALLOWED_ORIGINS) return DEFAULT_ALLOWED_ORIGINS;
    return env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
}

function isOriginAllowed(origin, env) {
    // No Origin header at all: not a browser-enforced context, so there is
    // nothing for CORS to protect here. Allowed, and rate-limited like
    // everything else.
    if (!origin) return true;
    return allowedOrigins(env).includes(origin);
}

function corsHeaders(origin, env) {
    const headers = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        // The response varies by request origin, so it must never be cached
        // under a key that ignores it.
        'Vary': 'Origin'
    };
    if (origin && isOriginAllowed(origin, env)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }
    return headers;
}

function json(data, status, origin, env) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) }
    });
}

function base64UrlToBytes(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function normalizeIssuer(value) {
    return String(value || '').replace(/\/+$/, '');
}

/* ==================================================================== *
 * Rate limiting
 *
 * The exchange endpoint is unauthenticated by necessity — it is called before
 * the caller has any identity — so without a cap anyone on the internet can
 * drive Codeforces' token endpoint using this deployment's client secret.
 *
 * Uses a KV namespace when one is bound (see the README), which is the only
 * version that holds across the many isolates a Worker runs in. Without one it
 * degrades to a per-isolate counter, which is weak but strictly better than
 * nothing and keeps the Worker deployable with no extra setup.
 * ==================================================================== */

const isolateHits = new Map();

function isolateRateLimited(key, now) {
    const windowStart = now - RATE_LIMIT_WINDOW_SECONDS * 1000;

    // Opportunistic sweep so a long-lived isolate does not accumulate keys.
    for (const [existing, hits] of isolateHits) {
        const live = hits.filter(at => at > windowStart);
        if (live.length) isolateHits.set(existing, live);
        else isolateHits.delete(existing);
    }

    const hits = (isolateHits.get(key) || []).filter(at => at > windowStart);
    hits.push(now);
    isolateHits.set(key, hits);
    return hits.length > RATE_LIMIT_MAX;
}

async function isRateLimited(request, env) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = `rl:${ip}`;

    if (!env.RATE_LIMIT_KV) {
        return isolateRateLimited(key, Date.now());
    }

    try {
        const current = Number(await env.RATE_LIMIT_KV.get(key)) || 0;
        if (current >= RATE_LIMIT_MAX) return true;
        // expirationTtl restarts on each write, making this a sliding window.
        // Good enough: the cap is about stopping abuse, not exact accounting.
        await env.RATE_LIMIT_KV.put(key, String(current + 1), {
            expirationTtl: RATE_LIMIT_WINDOW_SECONDS
        });
        return false;
    } catch (e) {
        // A KV outage must not take the login with it.
        console.warn('Rate-limit store unavailable; falling back to the isolate counter.', e);
        return isolateRateLimited(key, Date.now());
    }
}

/* ==================================================================== *
 * ID token verification
 * ==================================================================== */

// Codeforces signs its ID tokens with HS256 (see the discovery document),
// which per the OIDC spec uses the client secret as the HMAC key — so
// verifying the signature here proves the token really came from Codeforces
// and wasn't tampered with in transit, without needing a JWKS fetch.
async function verifyAndDecodeIdToken(idToken, secret, { clientId, nonce }) {
    const [headerB64, payloadB64, signatureB64] = String(idToken).split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) {
        throw new Error('Malformed ID token.');
    }

    // The signature is checked with HMAC regardless of what the header claims,
    // so an "alg": "none" or a swapped-in RS256 token simply fails to verify
    // rather than being trusted. Reading the header at all is only to reject
    // the confusing cases early with an accurate message.
    let header;
    try {
        header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64)));
    } catch {
        throw new Error('Malformed ID token header.');
    }
    if (header.alg !== 'HS256') {
        throw new Error(`Unexpected ID token algorithm "${header.alg}"; expected HS256.`);
    }

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
    );

    const valid = await crypto.subtle.verify(
        'HMAC',
        key,
        base64UrlToBytes(signatureB64),
        new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    if (!valid) {
        throw new Error('ID token signature verification failed.');
    }

    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
    } catch {
        throw new Error('Malformed ID token payload.');
    }

    const nowSeconds = Date.now() / 1000;

    // `exp` is required, not merely checked when present. A token with no
    // expiry is a token that is valid forever, and treating its absence as
    // "nothing to check" is the difference between a login and a permanent
    // credential.
    if (typeof payload.exp !== 'number') {
        throw new Error('ID token has no expiry.');
    }
    if (nowSeconds > payload.exp + CLOCK_SKEW_SECONDS) {
        throw new Error('ID token has expired.');
    }
    if (typeof payload.iat === 'number' && payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
        throw new Error('ID token is not valid yet.');
    }

    // iss/aud/nonce are verified when the token carries them, and their
    // absence is logged rather than fatal. The signing key here *is* the
    // client secret, so a valid signature already proves both the issuer and
    // the audience; these checks are defence in depth, and making them
    // mandatory would break every login if Codeforces ever trimmed a claim.
    if (payload.iss !== undefined && normalizeIssuer(payload.iss) !== EXPECTED_ISSUER) {
        throw new Error(`ID token issuer "${payload.iss}" is not Codeforces.`);
    }
    if (payload.aud !== undefined) {
        const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!audiences.includes(clientId)) {
            throw new Error('ID token was not issued for this client.');
        }
    }
    if (nonce && payload.nonce !== undefined && payload.nonce !== nonce) {
        throw new Error('ID token nonce did not match; the login may have been replayed.');
    }

    return payload;
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin');

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders(origin, env) });
        }

        const url = new URL(request.url);
        if (url.pathname !== EXCHANGE_PATH || request.method !== 'POST') {
            return json({ error: 'Not found.' }, 404, origin, env);
        }

        if (!isOriginAllowed(origin, env)) {
            return json({ error: 'Origin not allowed.' }, 403, origin, env);
        }

        if (!env.CF_CLIENT_SECRET) {
            return json({ error: 'Server misconfigured: CF_CLIENT_SECRET is not set.' }, 500, origin, env);
        }

        if (await isRateLimited(request, env)) {
            return json(
                { error: 'Too many login attempts. Wait a minute and try again.' },
                429,
                origin,
                env
            );
        }

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) {
            return json({ error: 'Request body too large.' }, 413, origin, env);
        }

        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            return json({ error: 'Invalid JSON body.' }, 400, origin, env);
        }

        const { code, clientId, nonce } = body || {};
        if (!code || !clientId) {
            return json({ error: 'code and clientId are required.' }, 400, origin, env);
        }
        if (typeof code !== 'string' || typeof clientId !== 'string') {
            return json({ error: 'code and clientId must be strings.' }, 400, origin, env);
        }

        // If CF_CLIENT_ID is configured, only ever exchange codes for that one
        // app — stops this deployment being reused to mint tokens for a
        // different, unrelated client.
        if (env.CF_CLIENT_ID && clientId !== env.CF_CLIENT_ID) {
            return json({ error: 'Unknown client_id.' }, 403, origin, env);
        }

        // Server-side, never from the request. See DEFAULT_REDIRECT_URI above.
        const redirectUri = env.CF_REDIRECT_URI || DEFAULT_REDIRECT_URI;

        let tokenResponse;
        try {
            tokenResponse = await fetch(CODEFORCES_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri,
                    client_id: clientId,
                    client_secret: env.CF_CLIENT_SECRET
                })
            });
        } catch (e) {
            return json({ error: `Could not reach Codeforces token endpoint: ${e.message}` }, 502, origin, env);
        }

        const tokenBody = await tokenResponse.text();
        let tokenData;
        try {
            tokenData = tokenBody ? JSON.parse(tokenBody) : {};
        } catch {
            tokenData = { error: tokenBody };
        }

        if (!tokenResponse.ok || !tokenData.id_token) {
            return json(
                { error: tokenData.error_description || tokenData.error || 'Codeforces token exchange failed.' },
                502,
                origin,
                env
            );
        }

        try {
            const claims = await verifyAndDecodeIdToken(tokenData.id_token, env.CF_CLIENT_SECRET, {
                clientId,
                nonce: typeof nonce === 'string' ? nonce : null
            });
            if (!claims.handle) {
                return json({ error: 'Codeforces token did not include a handle.' }, 502, origin, env);
            }
            return json(
                { handle: claims.handle, rating: claims.rating ?? null, avatar: claims.avatar ?? null },
                200,
                origin,
                env
            );
        } catch (e) {
            return json({ error: e.message }, 502, origin, env);
        }
    }
};
