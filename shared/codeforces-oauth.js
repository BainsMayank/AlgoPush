// Codeforces OpenID Connect login (https://codeforces.com/blog/entry/145566).
//
// This only verifies which Codeforces handle the user owns — it does NOT
// grant access to submission source code. Codeforces' token endpoint requires
// a client secret (client_secret_post), which can never live inside extension
// code, so the authorization-code exchange happens on a small backend
// (see oauth-backend/). That backend verifies the signed ID token and hands
// back only the plain handle/rating/avatar claims.
//
// Registered once, exactly like cf-pusher or any other "Login with X" button
// — every install of AlgoPush shares this one OAuth app + backend. Users
// never see or configure a Client ID or backend URL; they just click
// Connect. Anyone running their own fork/backend edits the two constants
// below — there is no in-app override, and no options UI for one.
export const DEFAULT_CF_OAUTH_CLIENT_ID = 'hCRJb9uFNQYxH18EvY7qnBsZLyBfmYzn';
export const DEFAULT_CF_OAUTH_EXCHANGE_URL = 'https://algopush-cf-oauth.mynklabs.workers.dev/auth/codeforces/exchange';

const CF_AUTHORIZE_URL = 'https://codeforces.com/oauth/authorize';

function buildAuthUrl(clientId, redirectUri, state, nonce) {
    const params = new URLSearchParams({
        response_type: 'code',
        scope: 'openid',
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        // OIDC replay protection: the provider echoes this back inside the ID
        // token, and the backend checks it matches. Sent unconditionally; the
        // backend only enforces it when Codeforces actually echoes one, so a
        // provider that ignores nonce cannot break the login.
        nonce
    });
    return `${CF_AUTHORIZE_URL}?${params.toString()}`;
}

function parseRedirect(redirectUrl) {
    const url = new URL(redirectUrl);
    // Be tolerant of either query or fragment delivery.
    const params = new URLSearchParams(url.search || url.hash.replace(/^#/, ''));
    return {
        code: params.get('code'),
        state: params.get('state'),
        error: params.get('error'),
        errorDescription: params.get('error_description')
    };
}

export function getRedirectUrl() {
    return chrome.identity.getRedirectURL();
}

/**
 * Runs the Codeforces "Login with Codeforces" flow via chrome.identity and
 * returns the verified { handle, rating, avatar } on success.
 */
export async function loginWithCodeforces({ clientId, exchangeUrl }) {
    if (!clientId) throw new Error('Set a Codeforces OAuth Client ID first.');
    if (!exchangeUrl) throw new Error('Set the OAuth exchange backend URL first.');

    const redirectUri = getRedirectUrl();
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const authUrl = buildAuthUrl(clientId, redirectUri, state, nonce);

    const redirectUrl = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (result) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!result) {
                reject(new Error('Codeforces login was cancelled.'));
                return;
            }
            resolve(result);
        });
    });

    const { code, state: returnedState, error, errorDescription } = parseRedirect(redirectUrl);

    if (error) {
        throw new Error(`Codeforces denied the login: ${error}${errorDescription ? ` (${errorDescription})` : ''}`);
    }
    if (returnedState !== state) {
        throw new Error('Codeforces login response failed a security check (state mismatch). Please try again.');
    }
    if (!code) {
        throw new Error('Codeforces did not return an authorization code.');
    }

    const response = await fetch(exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `redirectUri` is sent for diagnostics only — the backend pins its
        // own copy rather than trusting the caller's, so that a stolen
        // authorization code cannot be redeemed against a different callback.
        body: JSON.stringify({ code, redirectUri, clientId, nonce })
    });

    const raw = await response.text();
    let data;
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = { error: raw };
    }

    if (!response.ok || !data.handle) {
        throw new Error(data.error || `Codeforces login verification failed (HTTP ${response.status}).`);
    }

    return {
        handle: data.handle,
        rating: data.rating ?? null,
        avatar: data.avatar ?? null
    };
}
