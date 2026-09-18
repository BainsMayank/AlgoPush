// AtCoder account connect.
//
// AtCoder, like LeetCode and unlike Codeforces, publishes no OAuth/OIDC
// provider and no third-party app registration, so there is no authorization
// server to redirect to and no token to obtain. What the extension actually
// needs is the same thing the Codeforces login gives it — proof of *which
// account* this browser is, verified by AtCoder itself rather than typed in
// by hand — and AtCoder answers that directly: every page it serves declares
// the signed-in user's screen name, and declares it empty when nobody is
// signed in.
//
// The flow itself is shared with LeetCode and CodeChef — see
// shared/tab-rpc.js. The user's AtCoder password never touches the extension.

import { connectAccountViaTab } from './tab-rpc.js';

/**
 * Connects the user's AtCoder account and returns the verified
 * { username, rating } on success.
 *
 * `onStatus` is called with progress messages so the options page can narrate
 * a flow that may pause on the user for minutes.
 */
export function loginWithAtCoder({ onStatus } = {}) {
    return connectAccountViaTab({
        siteName: 'AtCoder',
        siteDomain: 'atcoder.jp',
        homeUrl: 'https://atcoder.jp/home',
        loginUrl: 'https://atcoder.jp/login',
        rpcType: 'AC_AUTH_PROFILE',
        onStatus,
        mapProfile: (profile) => ({
            username: profile.username,
            rating: profile.rating ?? null
        })
    });
}
