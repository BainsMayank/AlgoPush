import { refreshGitHubToken, DEFAULT_GITHUB_APP_CLIENT_ID } from './github-oauth.js';

// Refresh a bit early so a token that's about to expire mid-request doesn't
// slip through.
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Resolves which GitHub token to use for API calls: the GitHub App
 * device-flow token if connected, otherwise `githubToken` — a manually
 * entered fine-grained PAT from versions that had a field for one. Nothing
 * writes that key any more, so it survives only so an install upgrading from
 * those versions keeps working until it reconnects; it is not an option
 * users can choose today.
 *
 * Whether the OAuth token expires depends on the GitHub App's own "Expire
 * user authorization tokens" setting — that's a per-app choice made once at
 * registration, not something this extension controls per install. So this
 * handles both cases: if a refresh_token and expiry were issued, it
 * transparently refreshes an expiring token before returning it; if not
 * (expiry disabled), it just returns the token as-is, same as a PAT.
 */
export async function getEffectiveGithubToken() {
    const { githubOauthToken, githubOauthRefreshToken, githubOauthExpiresAt, githubToken } =
        await chrome.storage.local.get(['githubOauthToken', 'githubOauthRefreshToken', 'githubOauthExpiresAt', 'githubToken']);

    if (githubOauthToken) {
        const isExpiring = githubOauthExpiresAt && Date.now() > githubOauthExpiresAt - EXPIRY_SAFETY_MARGIN_MS;
        if (isExpiring && githubOauthRefreshToken) {
            try {
                const refreshed = await refreshGitHubToken(DEFAULT_GITHUB_APP_CLIENT_ID, githubOauthRefreshToken);
                const update = { githubOauthToken: refreshed.access_token };
                if (refreshed.refresh_token) update.githubOauthRefreshToken = refreshed.refresh_token;
                update.githubOauthExpiresAt = refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : null;
                await chrome.storage.local.set(update);
                return update.githubOauthToken;
            } catch (e) {
                console.error('AlgoPush: GitHub token refresh failed', e);
                // Fall through and try the (now-expired) token anyway rather
                // than silently switching to a stale manual PAT — the error
                // from GitHub's API will surface the real problem.
            }
        }
        return githubOauthToken;
    }

    return githubToken || null;
}
