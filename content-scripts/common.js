// Shared helpers for the four platform content scripts.
//
// Content scripts are not ES modules, so they cannot `import` from shared/.
// They can, however, be listed together in one manifest `content_scripts`
// entry: the files load in order into the same isolated world, so anything
// declared here is in scope for the platform script that follows. That is the
// only way these four scripts can share code, and without it the anti-bot
// detection lived in two copies and the drain lock in four.
//
// Exactly one platform script runs on any given page (the match patterns are
// disjoint), so these top-level bindings can never collide.

/* ------------------------------------------------------------------ *
 * Cloudflare / anti-bot detection
 *
 * A challenge means the request never reached the site, which is
 * recoverable, and must not be mistaken for "this submission has no
 * source", which is not.
 * ------------------------------------------------------------------ */

/**
 * Detects a Cloudflare interstitial in a *fetched response body*. Applied to
 * strings we got back from fetch(), where anything challenge-shaped means the
 * request did not reach the site itself.
 */
function isChallengeBody(html) {
    return /Just a moment|cf-mitigated|cf_chl_opt|cdn-cgi\/challenge-platform|Attention Required/i.test(html || '');
}

/**
 * Detects that the *currently rendered page* is a challenge page.
 *
 * Deliberately stricter than isChallengeBody(): Codeforces embeds a Turnstile
 * widget on some legitimate pages (login, registration), so merely spotting
 * "challenges.cloudflare.com" in the DOM would produce a false "we're blocked"
 * verdict on a perfectly usable page.
 */
function isChallengeDocument() {
    const title = document.title || '';
    if (/Just a moment|Attention Required|Access denied/i.test(title)) return true;
    return Boolean(document.querySelector('#challenge-form, #challenge-running, #cf-chl-widget, .cf-browser-verification'));
}

/* ------------------------------------------------------------------ *
 * Drain lock
 *
 * Keeps two open tabs on the same site from draining the same catch-up queue
 * at once. Duplicate pushes are harmless on their own (GitHub skips an
 * identical file), but duplicate source reads double the request rate against
 * sites that answer that by bouncing to a login page or an anti-bot check.
 * The lock self-expires so a tab closed mid-drain cannot wedge the queue.
 * ------------------------------------------------------------------ */

const DEFAULT_DRAIN_LOCK_TTL_MS = 2 * 60 * 1000;

// Distinct per tab, so a holder can be told apart from a contender.
const DRAIN_LOCK_OWNER = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Builds the { acquire, release } pair for one platform's queue.
 *
 * chrome.storage has no compare-and-set, so a plain read-then-write lets two
 * tabs that checked at the same moment both conclude they hold the lock.
 * Reading back after writing settles it: writes are serialised, so the last
 * writer is the only one whose owner id survives and everyone else stands
 * down.
 */
function createDrainLock(storageKey, ttlMs = DEFAULT_DRAIN_LOCK_TTL_MS) {
    return {
        async acquire() {
            const { [storageKey]: held } = await chrome.storage.local.get(storageKey);
            // `held.at` also screens out the plain-number lock written by
            // versions before this format, rather than letting it wedge the
            // queue until it expires.
            if (held && held.at && Date.now() - held.at < ttlMs) return false;

            await chrome.storage.local.set({ [storageKey]: { owner: DRAIN_LOCK_OWNER, at: Date.now() } });

            const { [storageKey]: confirmed } = await chrome.storage.local.get(storageKey);
            return Boolean(confirmed && confirmed.owner === DRAIN_LOCK_OWNER);
        },

        /** Only ever releases a lock this tab still holds. */
        async release() {
            const { [storageKey]: held } = await chrome.storage.local.get(storageKey);
            if (held && held.owner === DRAIN_LOCK_OWNER) {
                await chrome.storage.local.remove(storageKey);
            }
        }
    };
}
