// Content script for Codeforces

console.log("AlgoPush: Codeforces content script loaded.");

const HISTORY_HASH = '#algopush-history';
const IS_HISTORY_TAB = location.hash === HISTORY_HASH;

let currentHandle = null;

function getSubmissionIdFromPage() {
    const match = location.pathname.match(/\/(?:contest|gym)\/\d+\/submission\/(\d+)/);
    return match ? Number(match[1]) : null;
}

async function sendAcceptedSubmission(sub, code) {
    const problem = sub.problem;
    return chrome.runtime.sendMessage({
        type: 'SUBMISSION_ACCEPTED',
        platform: 'Codeforces',
        submissionId: sub.id,
        title: problem.name,
        slug: `${problem.contestId}-${problem.index}`,
        difficulty: problem.rating ? problem.rating.toString() : 'Unknown',
        tags: problem.tags || [],
        code,
        language: sub.programmingLanguage,
        judgedAt: sub.creationTimeSeconds ? sub.creationTimeSeconds * 1000 : null
    });
}

/**
 * Finds the current logged-in user's handle from the DOM.
 *
 * IMPORTANT: this must be scoped to the site header/navbar, not the whole
 * page. Pages like contest status/standings are full of *other* users'
 * "/profile/<handle>" links (submitters, standings rows, etc.) — searching
 * the whole document would grab the first one it finds, which is very
 * likely NOT you, and would poll/sync under the wrong account.
 */
function getHandle() {
    // The signed-in header reads "<handle> | Logout" inside .lang-chooser;
    // signed out it reads "Enter | Register" and holds no profile link at
    // all, which is exactly when a page-wide search used to fall through to
    // a stranger in the status table below it.
    const link = document.querySelector('#header .lang-chooser a[href^="/profile/"], .lang-chooser a[href^="/profile/"]');
    const match = link && link.getAttribute('href').match(/^\/profile\/([^/?#]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

/* ------------------------------------------------------------------ *
 * Submission source retrieval
 *
 * Codeforces has no public API for submission source code, but its own UI
 * reads it from /data/submitSource — a same-origin POST carrying the session
 * cookie and the page's CSRF token. Issuing that exact request from a content
 * script running on a real, already-loaded Codeforces page is indistinguishable
 * from clicking "source" in the UI, and crucially needs *no page navigation*
 * per submission. A bulk import therefore costs one page load in total rather
 * than one per submission, which is what used to trip Cloudflare's bot
 * management and block an entire historical import.
 * ------------------------------------------------------------------ */

let cachedCsrfToken = null;

function readCsrfTokenFromDocument() {
    const meta = document.querySelector('meta[name="X-Csrf-Token"]')?.content;
    if (meta && meta.trim()) return meta.trim();

    const input = document.querySelector('input[name="csrf_token"]')?.value;
    if (input && input.trim()) return input.trim();

    // Some Codeforces layouts only expose it via an inline script.
    const inline = document.documentElement.innerHTML.match(/csrf_token['"]?\s*[:=]\s*['"]([0-9a-f]{32})['"]/i);
    return inline ? inline[1] : null;
}

function readCsrfTokenFromHtml(html) {
    const meta = html.match(/name=["']X-Csrf-Token["']\s+content=["']([^"']+)["']/i);
    if (meta) return meta[1];
    const input = html.match(/name=["']csrf_token["']\s+value=["']([^"']+)["']/i);
    if (input) return input[1];
    const inline = html.match(/csrf_token['"]?\s*[:=]\s*['"]([0-9a-f]{32})['"]/i);
    return inline ? inline[1] : null;
}

/**
 * Returns a usable CSRF token, refreshing it from the server when the cached
 * one has been rejected. Codeforces rotates the token with the session, so a
 * long-running import must be able to pick up a new one without reloading
 * (and thereby re-exposing) the tab.
 */
async function ensureCsrfToken(forceRefresh = false) {
    if (!forceRefresh) {
        cachedCsrfToken = cachedCsrfToken || readCsrfTokenFromDocument();
        if (cachedCsrfToken) return cachedCsrfToken;
    }

    try {
        const response = await fetch('/', { credentials: 'same-origin' });
        const html = await response.text();
        if (isChallengeBody(html)) return null;
        const token = readCsrfTokenFromHtml(html);
        if (token) {
            cachedCsrfToken = token;
            return token;
        }
    } catch (e) {
        console.warn('AlgoPush: could not refresh the Codeforces CSRF token.', e);
    }

    return cachedCsrfToken || readCsrfTokenFromDocument();
}

/**
 * Fetches one submission's source.
 *
 * Returns exactly one of:
 *   { code }                     — success
 *   { challenged: true, error }  — Cloudflare/anti-bot stood in the way; the
 *                                  caller should recover (reload / let the
 *                                  user verify) and retry the SAME submission
 *   { retryable: true, error }   — transient server-side failure; back off
 *   { error }                    — permanent for this submission
 */
async function requestSubmissionSource(submissionId) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const csrfToken = await ensureCsrfToken(attempt > 0);
        if (!csrfToken) {
            return { challenged: true, error: 'Codeforces did not return a session token (anti-bot check or signed out).' };
        }

        let response;
        try {
            response = await fetch('/data/submitSource', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Csrf-Token': csrfToken,
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: new URLSearchParams({ submissionId: String(submissionId), csrf_token: csrfToken })
            });
        } catch (e) {
            return { retryable: true, error: `Network error contacting Codeforces: ${e.message}` };
        }

        const body = await response.text().catch(() => '');

        if (isChallengeBody(body)) {
            return { challenged: true, error: `Codeforces served an anti-bot challenge (HTTP ${response.status}).` };
        }

        if (response.status === 403) {
            // Almost always a rotated CSRF token — refresh once, then treat it
            // as an anti-bot block so the caller can recover rather than
            // burning through the whole queue reporting failures.
            if (attempt === 0) continue;
            return { challenged: true, error: 'Codeforces denied the source request (403).' };
        }

        if (response.status === 429 || response.status >= 500) {
            return { retryable: true, error: `Codeforces is throttling or unavailable (HTTP ${response.status}).` };
        }

        if (!response.ok) {
            return { error: `Codeforces returned HTTP ${response.status} for submission ${submissionId}.` };
        }

        let data;
        try {
            data = JSON.parse(body);
        } catch (_) {
            return { retryable: true, error: 'Codeforces returned an unexpected (non-JSON) response.' };
        }

        if (typeof data.source === 'string' && data.source.trim()) {
            return { code: data.source.replace(/\r\n/g, '\n') };
        }

        return { error: data.comment || `Codeforces returned no source for submission ${submissionId}.` };
    }

    return { challenged: true, error: 'Could not obtain a valid Codeforces session token.' };
}

/**
 * Reads source straight out of the rendered page — only used for the
 * submission page the user is actually looking at, which saves a request.
 */
function readRenderedSubmissionSource() {
    const selectors = [
        'pre#program-source-text',
        'pre.prettyprint',
        '.source pre',
        '#program-source-text'
    ];
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        const code = element?.innerText || element?.textContent;
        if (code && code.trim()) return code.replace(/\r\n/g, '\n');
    }
    return null;
}

/**
 * Polls the Codeforces API for the user's latest submissions.
 */
async function pollSubmissions() {
    if (!currentHandle) return;

    try {
        // Fetch the 10 most recent submissions
        const response = await fetch(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(currentHandle)}&from=1&count=10`);
        const data = await response.json();

        if (data.status !== "OK") {
            return;
        }

        const submissions = data.result;
        const submissionIdOnPage = getSubmissionIdFromPage();
        const sourceOnCurrentPage = readRenderedSubmissionSource();

        let { cfProcessedSubmissions = null, cfWatermarkSubmissionId = null } =
            await chrome.storage.local.get(['cfProcessedSubmissions', 'cfWatermarkSubmissionId']);

        let shouldSave = false;
        if (cfProcessedSubmissions === null) {
            // First time ever running the extension on this machine for Codeforces.
            cfProcessedSubmissions = [];
            for (const sub of submissions) {
                if (sub.verdict === 'OK' && sub.id !== submissionIdOnPage) {
                    cfProcessedSubmissions.push(sub.id);
                }
            }
            shouldSave = true;
        }

        // The watermark marks where live watching began, and is shared with
        // the service worker's catch-up pass (see background/service-worker.js)
        // so both agree on which submissions predate the install and therefore
        // belong to the historical import rather than to live sync.
        if (cfWatermarkSubmissionId === null) {
            const highest = submissions.reduce(
                (max, sub) => (sub.verdict === 'OK' && sub.id !== submissionIdOnPage ? Math.max(max, sub.id) : max),
                0
            );
            // Only ever write a watermark that something was actually seen at.
            // Ten recent submissions that all failed leave `highest` at 0, and
            // writing that would tell the service worker's catch-up pass — which
            // reads this same key — that every submission ever made is newer
            // than the watermark, i.e. a full unrequested backfill. The next
            // poll establishes it properly.
            if (highest > 0) {
                await chrome.storage.local.set({ cfWatermarkSubmissionId: highest });
            }
        }

        const processedSet = new Set(cfProcessedSubmissions);

        for (const sub of submissions) {
            // 'OK' is the verdict for Accepted in Codeforces
            if (sub.verdict !== 'OK' || processedSet.has(sub.id)) continue;

            processedSet.add(sub.id);
            cfProcessedSubmissions.push(sub.id);
            shouldSave = true;

            console.log("AlgoPush: Detected new accepted submission on Codeforces!", sub.id);

            const forget = () => {
                processedSet.delete(sub.id);
                cfProcessedSubmissions.splice(cfProcessedSubmissions.indexOf(sub.id), 1);
            };

            const result = sub.id === submissionIdOnPage && sourceOnCurrentPage
                ? { code: sourceOnCurrentPage }
                : await requestSubmissionSource(sub.id);

            if (result.code) {
                // Await the result so a GitHub error is visible in DevTools
                // and the submission can be retried rather than dropped.
                const syncResult = await sendAcceptedSubmission(sub, result.code);
                if (!syncResult || !syncResult.ok) {
                    console.error('AlgoPush: GitHub sync failed:', syncResult && syncResult.error);
                    forget();
                }
            } else {
                // Don't mark as processed — retry on the next poll instead
                // of silently dropping this Accepted submission.
                console.warn(`AlgoPush: could not read source for ${sub.id}: ${result.error}`);
                forget();
            }
        }

        if (shouldSave) {
            // Keep last 100 to avoid unbounded growth
            await chrome.storage.local.set({ cfProcessedSubmissions: cfProcessedSubmissions.slice(-100) });
        }
    } catch (e) {
        console.error("AlgoPush: Error polling Codeforces API", e);
    }
}

/**
 * Pushes submissions the service worker's catch-up pass found while no
 * Codeforces tab was open.
 *
 * The service worker can *detect* a missed Accepted submission from the
 * public user.status API without any tab, but it cannot read the source —
 * /data/submitSource only answers a same-origin request from a real page.
 * So it leaves them in `cfPendingSubmissions` and this drains that queue from
 * the first Codeforces page that loads.
 *
 * An item is only removed from the queue once GitHub has confirmed the push,
 * so a failure here means it is retried on the next page load rather than
 * lost — the exact failure mode this whole path exists to prevent.
 */
const drainLock = createDrainLock('cfDrainLock');

async function drainPendingSubmissions() {
    const { cfPendingSubmissions = [] } = await chrome.storage.local.get('cfPendingSubmissions');
    if (cfPendingSubmissions.length === 0) return;
    if (!(await drainLock.acquire())) return;

    console.log(`AlgoPush: draining ${cfPendingSubmissions.length} missed Codeforces submission(s).`);

    try {
        for (const item of cfPendingSubmissions) {
            const result = await requestSubmissionSource(item.id);
            if (!result.code) {
                // Anti-bot check or a transient failure — stop and keep the rest
                // queued rather than burning through them all against a wall.
                console.warn(`AlgoPush: could not read source for missed submission ${item.id}: ${result.error}`);
                break;
            }

            const syncResult = await chrome.runtime.sendMessage({
                type: 'SUBMISSION_ACCEPTED',
                platform: 'Codeforces',
                submissionId: item.id,
                title: item.title,
                slug: item.slug,
                difficulty: item.difficulty,
                tags: item.tags || [],
                code: result.code,
                language: item.programmingLanguage,
                judgedAt: item.judgedAt || null
            });

            if (!syncResult || !syncResult.ok) {
                console.error('AlgoPush: GitHub sync failed for missed submission:', syncResult && syncResult.error);
                break;
            }

            // Re-read rather than mutating a stale copy: the live poller writes
            // these same keys and may have run in between.
            const { cfPendingSubmissions: queue = [], cfProcessedSubmissions: done = [] } =
                await chrome.storage.local.get(['cfPendingSubmissions', 'cfProcessedSubmissions']);
            await chrome.storage.local.set({
                cfPendingSubmissions: queue.filter(entry => entry.id !== item.id),
                cfProcessedSubmissions: [...done, item.id].slice(-100)
            });

            // Same human pace the historical import uses.
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    } finally {
        await drainLock.release();
    }
}

// Codeforces documents a shared rate limit of roughly 1 request per 2
// seconds per API key/IP. Polling exactly every 2s (and doing so on every
// open tab) leaves no margin. Use a more conservative interval, and pause
// entirely while the tab isn't visible so background tabs don't burn quota.
const POLL_INTERVAL_MS = 5000;

/* ------------------------------------------------------------------ *
 * Historical-import RPC surface
 *
 * The options page drives the whole import through these messages against a
 * single, already-loaded Codeforces tab.
 * ------------------------------------------------------------------ */

const historyHandlers = {
    /** Liveness + "are we currently blocked / signed in?" probe. */
    async CF_HISTORY_STATUS() {
        const challenged = isChallengeDocument();
        return {
            ok: true,
            challenged,
            signedIn: Boolean(getHandle()),
            handle: getHandle(),
            hasCsrf: Boolean(readCsrfTokenFromDocument())
        };
    },

    /**
     * Runs user.status same-origin so the submission list travels over the
     * same authenticated connection as everything else in the import.
     */
    async CF_HISTORY_USER_STATUS({ handle }) {
        try {
            const response = await fetch(`/api/user.status?handle=${encodeURIComponent(handle)}`, { credentials: 'same-origin' });
            const body = await response.text();
            if (isChallengeBody(body)) return { challenged: true, error: 'Codeforces served an anti-bot challenge for the submissions list.' };
            if (!response.ok) return { retryable: true, error: `Codeforces API returned HTTP ${response.status}.` };

            let data;
            try {
                data = JSON.parse(body);
            } catch (_) {
                return { retryable: true, error: 'Codeforces API returned an unexpected response.' };
            }
            if (data.status !== 'OK') return { error: data.comment || 'Codeforces API error while listing submissions.' };
            return { ok: true, submissions: data.result || [] };
        } catch (e) {
            return { retryable: true, error: `Could not reach the Codeforces API: ${e.message}` };
        }
    },

    async CF_HISTORY_SOURCE({ submissionId }) {
        return requestSubmissionSource(submissionId);
    }
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handler = request && historyHandlers[request.type];
    if (!handler) return;

    handler(request)
        .then(sendResponse)
        .catch(e => sendResponse({ error: e.message || String(e) }));

    // Keep the channel open for the async handler above.
    return true;
});

/**
 * Initializes the polling mechanism if we are on a relevant page.
 */
async function startPolling() {
    currentHandle = getHandle();

    // With an account connected, only that account is ever synced: a browser
    // signed in to someone else's Codeforces must not push their solutions
    // into this repository.
    const { cfOauthProfile } = await chrome.storage.local.get('cfOauthProfile');
    const connected = cfOauthProfile && cfOauthProfile.handle;
    if (currentHandle && connected && currentHandle.toLowerCase() !== connected.toLowerCase()) {
        console.log(`AlgoPush: this browser is signed in to Codeforces as ${currentHandle}, but AlgoPush is connected to ${connected} — live sync is paused.`);
        return;
    }

    if (currentHandle) {
        console.log("AlgoPush: Found Codeforces handle:", currentHandle);
        // Seed `processedSubmissions`, then clear anything the service
        // worker queued while no Codeforces tab was open.
        pollSubmissions().then(drainPendingSubmissions);
        setInterval(() => {
            if (document.visibilityState === 'visible') {
                pollSubmissions();
            }
        }, POLL_INTERVAL_MS);
    } else {
        console.log("AlgoPush: Codeforces handle not found. Make sure you are logged in.");
    }
}

// Poll on normal pages to ensure we never miss a live submission. The
// dedicated historical-import tab only answers RPCs and must not create
// duplicate live-sync events for the same submissions.
if (!IS_HISTORY_TAB) {
    startPolling();
}
