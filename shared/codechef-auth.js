// CodeChef account connect.
//
// CodeChef, like LeetCode and AtCoder and unlike Codeforces, publishes no
// OAuth/OIDC provider and no third-party app registration, so there is no
// authorization server to redirect to and no token to obtain. What the
// extension actually needs is the same thing the Codeforces login gives it —
// proof of *which account* this browser is, verified by CodeChef itself rather
// than typed in by hand — and CodeChef answers that directly: `/api/user/me`,
// the endpoint its own header uses, names the signed-in user and answers with
// a null username when nobody is signed in.
//
// The flow itself is shared with LeetCode and AtCoder — see shared/tab-rpc.js.
// The check runs from a real codechef.com tab (not from the extension) for the
// same reason the historical import does: only a genuine page context carries
// the session cookie, and only it is reliably let through Cloudflare.

import { connectAccountViaTab } from './tab-rpc.js';

/**
 * Connects the user's CodeChef account and returns the verified
 * { username, rating, avatar, fullName } on success.
 *
 * `onStatus` is called with progress messages so the options page can narrate
 * a flow that may pause on the user for minutes.
 */
export function loginWithCodeChef({ onStatus } = {}) {
    return connectAccountViaTab({
        siteName: 'CodeChef',
        siteDomain: 'codechef.com',
        homeUrl: 'https://www.codechef.com/dashboard',
        loginUrl: 'https://www.codechef.com/login',
        rpcType: 'CC_AUTH_PROFILE',
        onStatus,
        mapProfile: (profile) => ({
            username: profile.username,
            rating: profile.rating ?? null,
            avatar: profile.avatar || null,
            fullName: profile.fullName || null
        })
    });
}
