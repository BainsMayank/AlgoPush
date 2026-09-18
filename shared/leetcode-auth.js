// LeetCode account connect.
//
// LeetCode — unlike Codeforces and GitHub — publishes no OAuth/OIDC provider
// and no developer app registration at all, so there is no authorization
// server to redirect to and no token to obtain: a "Login with LeetCode"
// button in the Codeforces sense cannot exist. What the extension actually
// needs from LeetCode is the same thing the Codeforces login gives it —
// proof of *which account* this browser is, verified by LeetCode itself
// rather than typed in by hand — and that is obtainable: LeetCode's own
// `globalData { userStatus }` query answers it, authoritatively, for
// whichever account the browser session belongs to.
//
// The flow itself — open a tab, ask, hand off to the site's sign-in page if
// nobody is signed in, finish by itself — is shared with AtCoder and CodeChef
// and lives in shared/tab-rpc.js. The query runs from a real leetcode.com tab
// (not from the extension) for the same reason the historical import does:
// only a genuine page context carries the session cookie and CSRF token
// LeetCode requires.

import { connectAccountViaTab } from './tab-rpc.js';

/**
 * Connects the user's LeetCode account and returns the verified
 * { username, realName, avatar, ranking } on success.
 *
 * `onStatus` is called with progress messages so the options page can narrate
 * a flow that may pause on the user for minutes.
 */
export function loginWithLeetCode({ onStatus } = {}) {
    return connectAccountViaTab({
        siteName: 'LeetCode',
        siteDomain: 'leetcode.com',
        homeUrl: 'https://leetcode.com/',
        loginUrl: 'https://leetcode.com/accounts/login/',
        rpcType: 'LC_AUTH_PROFILE',
        onStatus,
        mapProfile: (profile) => ({
            username: profile.username,
            realName: profile.realName || null,
            avatar: profile.avatar || null,
            ranking: profile.ranking ?? null
        })
    });
}
