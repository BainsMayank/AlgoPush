// GitHub App "Device Flow" login
// (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
//
// Unlike Codeforces' OAuth, GitHub's device flow needs no client secret at
// all — that's exactly why CLI tools like `gh` and Docker use it for exactly
// this "public client with no server" scenario. So this runs entirely inside
// the extension, no backend required. Registered once as a GitHub App
// (Device Flow enabled, Repository permissions: Contents Read & write, token
// expiry disabled) — every install of AlgoPush shares this one app, exactly
// like the Codeforces OAuth app. Users never register anything themselves;
// they click Connect, enter a code on github.com, and pick which repo(s) to
// install the app on.

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Registered once, shared by every install — not sensitive, this is public,
// visible in every request the same way a URL parameter is.
export const DEFAULT_GITHUB_APP_CLIENT_ID = 'Iv23lim9HeTK3DJqGCkE';

export async function startDeviceFlow(clientId) {
    if (!clientId) throw new Error('GitHub OAuth Client ID is not set.');

    // GitHub's device/token endpoints expect a form-urlencoded body (this is
    // what their own docs/examples send) — JSON isn't reliably accepted and
    // returns a bare 400 with no useful body.
    const response = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId })
    });
    const data = await response.json().catch(() => ({}));
    if (!data.device_code) {
        throw new Error(
            data.error_description || data.error ||
            `Could not start GitHub login (HTTP ${response.status}). Check that Device Flow is enabled for the app.`
        );
    }
    return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

/**
 * Polls GitHub until the user finishes entering the code on
 * github.com/login/device, following the interval/slow_down/pending
 * semantics the device flow spec requires.
 */
export async function pollForGitHubToken(clientId, deviceCode, intervalSec, expiresInSec) {
    const deadline = Date.now() + expiresInSec * 1000;
    let interval = intervalSec;

    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));

        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
            })
        });
        const data = await response.json();

        if (data.access_token) return data; // { access_token, token_type, scope, ... }
        if (data.error === 'authorization_pending') continue;
        if (data.error === 'slow_down') { interval = (data.interval || interval) + 5; continue; }
        if (data.error === 'expired_token') throw new Error('The GitHub login code expired. Please try again.');
        if (data.error === 'access_denied') throw new Error('GitHub login was cancelled.');
        throw new Error(data.error_description || data.error || 'GitHub login failed.');
    }
    throw new Error('Timed out waiting for GitHub authorization.');
}

/**
 * Exchanges a refresh token for a new access token. Only relevant if the
 * GitHub App has "Expire user authorization tokens" enabled (GitHub's
 * default for new apps — access tokens then expire after 8h and come with a
 * refresh_token). Like the rest of device flow, this needs no client secret.
 * If the app has that setting turned off, no refresh_token is ever issued
 * and this is simply never called.
 */
export async function refreshGitHubToken(clientId, refreshToken) {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        })
    });
    const data = await response.json();
    if (!data.access_token) {
        throw new Error(data.error_description || data.error || 'Could not refresh the GitHub connection. Reconnect GitHub in options.');
    }
    return data; // { access_token, refresh_token, expires_in, refresh_token_expires_in, ... }
}

/**
 * Fetches the user's own profile (for display) and the repositories the
 * GitHub App installation(s) actually grant access to, so the user can pick
 * one instead of typing "owner/repo" by hand.
 */
export async function fetchGitHubIdentity(token) {
    const response = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!response.ok) throw new Error(`Could not fetch GitHub profile (HTTP ${response.status}).`);
    const data = await response.json();
    return { login: data.login, avatar: data.avatar_url };
}

export async function listInstallations(token) {
    const response = await fetch('https://api.github.com/user/installations', {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!response.ok) {
        throw new Error(`Could not list GitHub App installations (HTTP ${response.status}).`);
    }
    return (await response.json()).installations || [];
}

export async function listInstalledRepositories(token) {
    const installations = await listInstallations(token);

    const repos = [];
    for (const installation of installations) {
        const reposResponse = await fetch(`https://api.github.com/user/installations/${installation.id}/repositories`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
        });
        if (!reposResponse.ok) continue;
        const reposData = await reposResponse.json();
        for (const repo of reposData.repositories || []) {
            repos.push({ fullName: repo.full_name, defaultBranch: repo.default_branch, installationId: installation.id });
        }
    }
    return repos;
}

/**
 * Picks the installation to create new repos under: prefers the user's own
 * personal account (not an org) since that's the common case, falling back
 * to whichever installation exists.
 */
export async function getPrimaryInstallation(token, login) {
    const installations = await listInstallations(token);
    if (installations.length === 0) return null;
    return installations.find(i => i.account && i.account.login === login) || installations[0];
}

/**
 * Creates a new repository for the authenticated user (with an initial
 * commit, so it has a real default branch immediately) and grants the
 * GitHub App installation access to it — new repos aren't automatically
 * visible to a "selected repositories" installation otherwise.
 */
export async function createRepository(token, name, installationId) {
    const createResponse = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            name,
            private: true,
            auto_init: true,
            description: 'Algorithm solutions synced by AlgoPush'
        })
    });
    const repoData = await createResponse.json();
    if (!createResponse.ok) {
        throw new Error(repoData.message || `Could not create repository (HTTP ${createResponse.status}).`);
    }

    if (installationId) {
        const addResponse = await fetch(
            `https://api.github.com/user/installations/${installationId}/repositories/${repoData.id}`,
            { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' } }
        );
        // 404 here just means the installation already has "all repositories"
        // access, so there's nothing to add — not a real failure.
        if (!addResponse.ok && addResponse.status !== 404) {
            console.warn(`AlgoPush: repo created but could not confirm GitHub App access (HTTP ${addResponse.status}). It may already have it.`);
        }
    }

    return { fullName: repoData.full_name, defaultBranch: repoData.default_branch };
}
