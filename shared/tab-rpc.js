// Shared plumbing for talking to a content script in a background tab.
//
// Both the historical import (options/options.js) and the LeetCode account
// connect flow (shared/leetcode-auth.js) work the same way: open one tab on
// the platform's own site so every request carries the real session cookie
// and CSRF token from a genuine page context, then drive it over
// chrome.tabs.sendMessage. The awkward parts — a tab that finished loading
// before the listener was attached, and the gap between "tab loaded" and
// "content script listening" — are the same for both, so they live here.

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function waitForTabComplete(tabId, timeoutMs = 45000) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(ok);
        };
        const listener = (id, changeInfo) => {
            if (id === tabId && changeInfo.status === 'complete') finish(true);
        };
        chrome.tabs.onUpdated.addListener(listener);
        // The load may already have finished before the listener was attached.
        chrome.tabs.get(tabId).then(tab => {
            if (tab && tab.status === 'complete') finish(true);
        }).catch(() => finish(false));
        setTimeout(() => finish(false), timeoutMs);
    });
}

/**
 * Sends a message to a tab, tolerating the window between "tab loaded" and
 * "content script listening".
 */
export async function sendToTab(tabId, message, { retries = 8, retryDelayMs = 400 } = {}) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await chrome.tabs.sendMessage(tabId, message);
            if (response) return response;
        } catch (_) {
            // Content script not injected yet, or the tab is navigating.
        }
        await sleep(retryDelayMs);
    }
    return { retryable: true, error: 'The tab did not respond.' };
}

/* ==================================================================== *
 * One-click "connect account" flow
 *
 * LeetCode, AtCoder and CodeChef all publish no OAuth provider and no
 * third-party app registration, so none of them can offer a redirect-based
 * login. What the extension actually needs from each is the same thing the
 * Codeforces login gives it — proof of *which account* this browser is,
 * answered by the site itself rather than typed in by the user — and all
 * three answer that from a page they already serve.
 *
 * So all three flows are the same flow: open one background tab on the site,
 * ask the content script who is signed in, and if nobody is, hand off to the
 * site's own sign-in page and finish by itself the moment the user signs in.
 * The user's password never touches the extension in any of them.
 *
 * Only three things differ per platform — which URLs, which RPC message, and
 * which fields the answer carries — so those are the parameters and this is
 * the flow.
 * ==================================================================== */

const CONNECT_HASH = '#algopush-connect';

// How long to leave the sign-in tab open waiting for the user before giving
// up. Generous on purpose: signing in can mean a password manager, an email
// round trip, or a two-factor prompt.
const SIGN_IN_WAIT_MS = 5 * 60 * 1000;
const SIGN_IN_POLL_MS = 2000;

export function connectHashUrl(url) {
    return `${url}${CONNECT_HASH}`;
}

async function openConnectTab(url, active) {
    const tab = await chrome.tabs.create({ url, active });
    await waitForTabComplete(tab.id);
    // Give the content script a moment to register its message listener.
    await sleep(400);
    return tab.id;
}

/**
 * Runs the shared connect flow and returns the platform's own profile object.
 *
 * @param {object}   options
 * @param {string}   options.siteName    Human name, used in error messages.
 * @param {string}   options.siteDomain  The domain to point the user at.
 * @param {string}   options.homeUrl     A page the content script runs on.
 * @param {string}   options.loginUrl    The site's own sign-in page.
 * @param {string}   options.rpcType     The content script's profile message.
 * @param {function} options.mapProfile  Turns the RPC answer into what storage keeps.
 * @param {function} [options.onStatus]  Progress narration for the options page.
 */
export async function connectAccountViaTab({ siteName, siteDomain, homeUrl, loginUrl, rpcType, mapProfile, onStatus = () => {} }) {
    let tabId = null;
    let optionsTabId = null;

    try {
        const currentTab = await chrome.tabs.getCurrent();
        optionsTabId = currentTab ? currentTab.id : null;
    } catch (_) { /* options page opened outside a tab */ }

    const readProfile = async (options) => {
        const result = await sendToTab(tabId, { type: rpcType }, options);
        if (!result.ok) {
            throw new Error(result.error || `The ${siteName} tab could not be reached. Make sure ${siteDomain} loads in this browser, then try again.`);
        }
        return result;
    };

    try {
        onStatus(`Checking your ${siteName} session…`);
        tabId = await openConnectTab(connectHashUrl(homeUrl), false);

        // A failed first read is treated as "not signed in" rather than as a
        // hard error. Whether the site answered "nobody is signed in", bounced
        // the request, or showed an anti-bot check, the right next step is the
        // same — show the user the sign-in page.
        let profile;
        try {
            profile = await readProfile();
        } catch (error) {
            console.warn(`AlgoPush: initial ${siteName} session check failed, falling back to sign-in.`, error);
            profile = { signedIn: false };
        }

        if (!profile.signedIn) {
            // Hand off to the site's own sign-in page, in the tab that is
            // already open, and bring it forward so the user sees what they
            // are being asked for.
            onStatus(`Opening the ${siteName} sign-in page — this finishes by itself once you sign in.`);

            await chrome.tabs.update(tabId, { url: loginUrl, active: true });
            try {
                const tab = await chrome.tabs.get(tabId);
                await chrome.windows.update(tab.windowId, { focused: true });
            } catch (_) { /* best effort */ }
            await waitForTabComplete(tabId);

            const deadline = Date.now() + SIGN_IN_WAIT_MS;
            while (Date.now() < deadline) {
                await sleep(SIGN_IN_POLL_MS);

                // The tab navigates as the user signs in, so a miss here is
                // expected rather than fatal — keep polling until the deadline.
                let poll;
                try {
                    poll = await readProfile({ retries: 2, retryDelayMs: 500 });
                } catch (_) {
                    continue;
                }

                if (poll.signedIn) {
                    profile = poll;
                    break;
                }
            }

            if (!profile.signedIn) {
                throw new Error(`Timed out waiting for the ${siteName} sign-in. Sign in at ${siteDomain}, then click Connect again.`);
            }

            if (optionsTabId !== null) {
                try { await chrome.tabs.update(optionsTabId, { active: true }); } catch (_) {}
            }
        }

        if (!profile.username) {
            throw new Error(`${siteName} reported a signed-in session but no username. Reload ${siteDomain} and try again.`);
        }

        return mapProfile(profile);
    } finally {
        if (tabId !== null) {
            try { await chrome.tabs.remove(tabId); } catch (_) {}
        }
    }
}
