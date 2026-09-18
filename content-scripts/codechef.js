// Content script for CodeChef
//
// CodeChef sits behind Cloudflare and answers a request for anything
// submission-shaped only when it carries the signed-in session — the same
// situation as Codeforces. So everything here runs same-origin from a real
// codechef.com page: the user's password never goes near the extension, no
// credentials are stored anywhere, and every request is indistinguishable from
// one the site's own UI makes.
//
// CodeChef does publish three JSON endpoints its own front end uses, which is
// what makes this the least brittle of the four platforms:
//   /api/user/me                            — who this browser is signed in as
//   /recent/user?user_handle=…&page=N       — submission history (HTML rows)
//   /api/submission-code/<id>               — one submission's source
//   /api/contests/<contest>/problems/<code> — title, difficulty and tags

console.log('AlgoPush: CodeChef content script loaded.');

const HISTORY_HASH = '#algopush-history';
const IS_HISTORY_TAB = location.hash === HISTORY_HASH;

let currentHandle = null;

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * Asks CodeChef which account this browser is — authoritatively, from the same
 * endpoint its own header uses, rather than by guessing from the DOM.
 *
 * Returns { signedIn, username, rating, avatar, fullName }, or a
 * { retryable } failure when the request itself did not get through.
 */
async function readSignedInUser() {
    let response;
    try {
        response = await fetch('/api/user/me', {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' }
        });
    } catch (error) {
        return { ok: false, retryable: true, error: `Network error contacting CodeChef: ${error.message}` };
    }

    const body = await response.text().catch(() => '');

    // A 429 is checked before the challenge body, and on purpose. Cloudflare
    // wraps a rate-limit response in the same "Just a moment" markup it uses
    // for a real challenge, and the two need opposite handling: throttling is
    // fixed by backing off and slowing the run down, while a challenge is
    // fixed by reloading the tab or letting the user click through. A 503 is
    // left to the challenge check below, because that status genuinely is how
    // a managed challenge arrives.
    if (response.status === 429) {
        return { ok: false, retryable: true, error: 'CodeChef is rate-limiting requests (HTTP 429).' };
    }
    if (isChallengeBody(body)) {
        return { ok: false, challenged: true, error: 'CodeChef served an anti-bot challenge.' };
    }
    if (response.status >= 500) {
        return { ok: false, retryable: true, error: `CodeChef is unavailable (HTTP ${response.status}).` };
    }
    if (!response.ok) {
        return { ok: false, error: `CodeChef returned HTTP ${response.status} for the account check.` };
    }

    let payload;
    try {
        payload = JSON.parse(body);
    } catch (_) {
        return { ok: false, retryable: true, error: 'CodeChef returned an unexpected (non-JSON) account response.' };
    }

    const user = (payload && payload.user) || {};
    if (!user.username) return { ok: true, signedIn: false };

    return {
        ok: true,
        signedIn: true,
        username: user.username,
        // -1 is CodeChef's "unrated", not a rating of minus one.
        rating: typeof user.rating === 'number' && user.rating > 0 ? user.rating : null,
        avatar: user.profileImagePath || null,
        fullName: user.fullName || null
    };
}

/* ------------------------------------------------------------------ *
 * Submission history
 *
 * `/recent/user` answers with { max_page, content }, where `content` is a
 * rendered HTML table rather than data. It is parsed here with DOMParser; the
 * service worker's catch-up pass reads the same four fields out of the same
 * markup with a regex, because a service worker has no DOMParser at all (see
 * shared/codechef-catalog.js).
 *
 * Paging has one sharp edge worth knowing: asking for a page past the last one
 * does not return empty, it returns the last page again. So a walk has to stop
 * on `max_page` *and* on a page that adds nothing new.
 * ------------------------------------------------------------------ */

/**
 * Extracts the Accepted submissions from one page of the recent-submissions
 * table.
 *
 * Two details matter:
 *   - The verdict is compared for equality with "accepted", not by substring:
 *     CodeChef's other verdict is "partially accepted", and pushing a 40/100
 *     submission as a solved problem would be wrong.
 *   - A row whose "View" link is disabled carries no submission id, so its
 *     source can never be fetched. CodeChef always lets you view your own
 *     solutions, so this should never happen for the connected account — it is
 *     flagged as `unavailable` rather than dropped precisely so that, if it
 *     ever does, it shows up as a counted anomaly instead of a silently
 *     smaller total than the user knows they have solved.
 */
function parseRecentRows(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [];

    for (const row of doc.querySelectorAll('tr')) {
        // An exact attribute match, not a substring one: CodeChef's other
        // verdict is "partially accepted", which contains it.
        if (!row.querySelector('span[title="accepted"]')) continue;

        const problemLink = row.querySelector('a[href*="/problems/"]');
        if (!problemLink) continue;

        const problemMatch = problemLink.getAttribute('href')
            .match(/^\/(?:([^/]+)\/)?problems\/([^/?#]+)/);
        if (!problemMatch) continue;

        const solutionLink = row.querySelector('a[href*="/viewsolution/"]');
        const idMatch = solutionLink && solutionLink.getAttribute('href').match(/\/viewsolution\/(\d+)/);

        // The language cell is the one immediately before the "View" cell —
        // read positionally because, unlike AtCoder, this table carries no
        // <th> labels inside the fragment to match against.
        const cells = Array.from(row.querySelectorAll('td'));
        const language = cells.length >= 2 ? cells[cells.length - 2].textContent.trim() : '';

        rows.push({
            id: idMatch ? Number(idMatch[1]) : null,
            problemCode: problemMatch[2],
            contestCode: problemMatch[1] || '',
            language,
            unavailable: !idMatch
        });
    }

    return rows;
}

/**
 * Fetches one page of the signed-in user's recent submissions.
 *
 * Returns exactly one of:
 *   { ok, maxPage, rows }        — success
 *   { challenged: true, error }  — Cloudflare stood in the way; recover and retry
 *   { retryable: true, error }   — transient failure; back off
 *   { error }                    — permanent for this request
 */
async function fetchRecentPage(handle, page) {
    let response;
    try {
        response = await fetch(
            `/recent/user?user_handle=${encodeURIComponent(handle)}&page=${page}`,
            { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } }
        );
    } catch (error) {
        return { retryable: true, error: `Network error contacting CodeChef: ${error.message}` };
    }

    const body = await response.text().catch(() => '');

    // See the note in readSignedInUser() above for why 429 comes first.
    if (response.status === 429) {
        return { retryable: true, error: 'CodeChef is rate-limiting requests (HTTP 429).' };
    }
    if (isChallengeBody(body)) {
        return { challenged: true, error: `CodeChef served an anti-bot challenge (HTTP ${response.status}).` };
    }
    if (response.status >= 500) {
        return { retryable: true, error: `CodeChef is unavailable (HTTP ${response.status}).` };
    }
    if (!response.ok) {
        return { error: `CodeChef returned HTTP ${response.status} for your submission list.` };
    }

    let payload;
    try {
        payload = JSON.parse(body);
    } catch (_) {
        return { retryable: true, error: 'CodeChef returned an unexpected (non-JSON) submission list.' };
    }
    if (!payload || typeof payload.content !== 'string') {
        return { retryable: true, error: 'CodeChef returned an empty submission list.' };
    }

    return {
        ok: true,
        maxPage: Number(payload.max_page) || 0,
        rows: parseRecentRows(payload.content)
    };
}

/* ------------------------------------------------------------------ *
 * Submission source
 * ------------------------------------------------------------------ */

/**
 * Fetches one submission's source.
 *
 * Returns the same result shape as the Codeforces and AtCoder equivalents, so
 * the shared historical-import engine treats all four platforms identically.
 */
async function requestSubmissionSource(submissionId) {
    let response;
    try {
        response = await fetch(`/api/submission-code/${encodeURIComponent(submissionId)}`, {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' }
        });
    } catch (error) {
        return { retryable: true, error: `Network error contacting CodeChef: ${error.message}` };
    }

    const body = await response.text().catch(() => '');

    // See the note in readSignedInUser() above for why 429 comes first.
    if (response.status === 429) {
        return { retryable: true, error: 'CodeChef is rate-limiting requests (HTTP 429).' };
    }
    if (isChallengeBody(body)) {
        return { challenged: true, error: `CodeChef served an anti-bot challenge (HTTP ${response.status}).` };
    }
    if (response.status === 401 || response.status === 403) {
        // Recoverable the same way a challenge is: either the session lapsed
        // or Cloudflare stepped in, and both are fixed by the same handoff.
        return { challenged: true, error: 'CodeChef denied the source request — your session may have expired.' };
    }
    if (response.status >= 500) {
        return { retryable: true, error: `CodeChef is unavailable (HTTP ${response.status}).` };
    }
    if (!response.ok) {
        return { error: `CodeChef returned HTTP ${response.status} for submission ${submissionId}.` };
    }

    let payload;
    try {
        payload = JSON.parse(body);
    } catch (_) {
        return { retryable: true, error: 'CodeChef returned an unexpected (non-JSON) source response.' };
    }

    const source = payload && payload.data && payload.data.code;
    if (typeof source !== 'string' || !source.trim()) {
        return { error: (payload && payload.message) || `CodeChef returned no source for submission ${submissionId}.` };
    }

    const language = payload.data.language || {};
    return {
        code: source.replace(/\r\n/g, '\n'),
        language: language.full_name || language.short_name || '',
        // CodeChef names the file extension itself, which beats deriving one
        // from the language name: its short names ("PYTH 3", "NODEJS", "CS2")
        // are not the language names the shared pattern table expects.
        extension: language.extension || ''
    };
}

/* ------------------------------------------------------------------ *
 * Problem metadata
 *
 * Fetched here, from a real page, rather than left entirely to the service
 * worker: this request is same-origin and therefore always gets through,
 * whereas the worker's cross-origin fallback can be turned away by Cloudflare.
 * Attaching it to the payload means the worker only has to look anything up
 * when this failed.
 * ------------------------------------------------------------------ */

const metaCache = new Map();

async function fetchProblemMeta(problemCode, contestCode) {
    const cacheKey = `${contestCode || 'PRACTICE'}/${problemCode}`;
    if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);

    const contests = [];
    if (contestCode && contestCode !== 'PRACTICE') contests.push(contestCode);
    contests.push('PRACTICE');

    let meta = null;
    for (const contest of contests) {
        try {
            const response = await fetch(
                `/api/contests/${encodeURIComponent(contest)}/problems/${encodeURIComponent(problemCode)}`,
                { credentials: 'same-origin', headers: { 'Accept': 'application/json' } }
            );
            if (!response.ok) continue;

            const payload = await response.json();
            if (!payload || payload.status !== 'success') continue;

            const userTags = Array.isArray(payload.user_tags) ? payload.user_tags.filter(Boolean) : [];
            const computedTags = Array.isArray(payload.computed_tags) ? payload.computed_tags.filter(Boolean) : [];

            meta = {
                title: payload.problem_name || problemCode,
                // Left as the raw rating: the service worker owns the mapping
                // from rating to difficulty band, so every path into the repo
                // files a problem in exactly the same folder.
                difficultyRating: payload.difficulty_rating,
                tags: userTags.length ? userTags : computedTags
            };
            break;
        } catch (error) {
            console.warn(`AlgoPush: CodeChef metadata lookup failed for ${problemCode}.`, error);
        }
    }

    if (meta) metaCache.set(cacheKey, meta);
    return meta;
}

/* ------------------------------------------------------------------ *
 * Live sync
 *
 * CodeChef has a single cross-contest submission list, so — unlike AtCoder —
 * the live poller sees everything from any CodeChef page. Newest first, so
 * only the first page has to be read.
 *
 * Anything this misses (submitted, then the tab closed before the judge
 * finished) is caught by the service worker's catch-up pass instead.
 * ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 8000;
const PROCESSED_LIMIT = 200;

async function pushSubmission({ id, problemCode, contestCode, language }, code, sourceLanguage, fileExtension) {
    const meta = await fetchProblemMeta(problemCode, contestCode);

    return chrome.runtime.sendMessage({
        type: 'SUBMISSION_ACCEPTED',
        platform: 'CodeChef',
        submissionId: id,
        // The problem code stands in until the service worker resolves the
        // real title — it is never left as the final title unless every
        // metadata lookup failed.
        title: (meta && meta.title) || problemCode,
        slug: problemCode,
        problemCode,
        contestCode,
        difficultyRating: meta ? meta.difficultyRating : null,
        difficulty: 'Unknown',
        tags: (meta && meta.tags) || [],
        code,
        language: sourceLanguage || language || 'Unknown',
        fileExtension: fileExtension || ''
    });
}

async function pollSubmissions() {
    if (!currentHandle) return;

    const page = await fetchRecentPage(currentHandle, 0);
    if (!page.ok) {
        console.warn('AlgoPush: could not read the CodeChef submission list.', page.error);
        return;
    }

    const accepted = page.rows.filter(row => row.id !== null);
    if (!accepted.length) return;

    const { ccProcessedSubmissions = null, ccWatermarkSubmissionId = null } =
        await chrome.storage.local.get(['ccProcessedSubmissions', 'ccWatermarkSubmissionId']);

    const highest = accepted.reduce((max, row) => Math.max(max, row.id), 0);

    // First run on this machine: everything already on screen predates the
    // install and belongs to the historical import, not to a surprise
    // backfill. The watermark is shared with the service worker's catch-up
    // pass so the two can never disagree about where live sync began.
    if (ccProcessedSubmissions === null) {
        await chrome.storage.local.set({
            ccProcessedSubmissions: accepted.map(row => row.id).slice(-PROCESSED_LIMIT)
        });
    }
    if (ccWatermarkSubmissionId === null) {
        await chrome.storage.local.set({ ccWatermarkSubmissionId: highest });
        return;
    }

    const processed = new Set(ccProcessedSubmissions || accepted.map(row => row.id));

    // Oldest first, so a burst of submissions lands in the order it happened.
    for (const row of accepted.slice().sort((a, b) => a.id - b.id)) {
        if (row.id <= ccWatermarkSubmissionId || processed.has(row.id)) continue;

        console.log('AlgoPush: detected a new accepted submission on CodeChef.', row.id);

        const source = await requestSubmissionSource(row.id);
        if (!source.code) {
            // Leave it unprocessed so the next poll retries, rather than
            // silently dropping an Accepted submission.
            console.warn(`AlgoPush: could not read source for ${row.id}: ${source.error}`);
            continue;
        }

        const syncResult = await pushSubmission(row, source.code, source.language, source.extension);
        if (!syncResult || !syncResult.ok) {
            console.error('AlgoPush: GitHub sync failed:', syncResult && syncResult.error);
            continue;
        }

        // Re-read rather than mutating a stale copy: the pending drain below
        // writes this same key.
        const { ccProcessedSubmissions: done = [] } = await chrome.storage.local.get('ccProcessedSubmissions');
        await chrome.storage.local.set({ ccProcessedSubmissions: [...done, row.id].slice(-PROCESSED_LIMIT) });
        processed.add(row.id);
    }
}

/* ------------------------------------------------------------------ *
 * Catch-up queue drain
 *
 * The service worker can *detect* a missed Accepted submission without a tab,
 * but it cannot read the source — CodeChef only serves that to the signed-in
 * session. So it leaves them in `ccPendingSubmissions` and this drains the
 * queue from the first CodeChef page that loads. An item is only removed once
 * GitHub has confirmed the push, so a failure means a retry on the next page
 * load rather than a loss.
 * ------------------------------------------------------------------ */

const drainLock = createDrainLock('ccDrainLock');

async function drainPendingSubmissions() {
    const { ccPendingSubmissions = [] } = await chrome.storage.local.get('ccPendingSubmissions');
    if (ccPendingSubmissions.length === 0) return;
    if (!(await drainLock.acquire())) return;

    console.log(`AlgoPush: draining ${ccPendingSubmissions.length} missed CodeChef submission(s).`);

    try {
        for (const item of ccPendingSubmissions) {
            const source = await requestSubmissionSource(item.id);
            if (!source.code) {
                // Signed out, challenged or throttled — keep the rest queued
                // rather than burning through them all against a wall.
                console.warn(`AlgoPush: could not read source for missed submission ${item.id}: ${source.error}`);
                break;
            }

            const syncResult = await pushSubmission(item, source.code, source.language, source.extension);
            if (!syncResult || !syncResult.ok) {
                console.error('AlgoPush: GitHub sync failed for missed submission:', syncResult && syncResult.error);
                break;
            }

            const { ccPendingSubmissions: queue = [], ccProcessedSubmissions: done = [] } =
                await chrome.storage.local.get(['ccPendingSubmissions', 'ccProcessedSubmissions']);
            await chrome.storage.local.set({
                ccPendingSubmissions: queue.filter(entry => entry.id !== item.id),
                ccProcessedSubmissions: [...done, item.id].slice(-PROCESSED_LIMIT)
            });

            // Same human pace the historical import uses.
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    } finally {
        await drainLock.release();
    }
}

/* ------------------------------------------------------------------ *
 * RPC surface
 *
 * Used by the one-click connect (shared/codechef-auth.js) and by the
 * historical import (options/options.js), both of which drive a single
 * background codechef.com tab.
 * ------------------------------------------------------------------ */

const rpcHandlers = {
    /**
     * Answers "which CodeChef account is this browser?" — the one thing the
     * Connect button needs, straight from CodeChef's own session rather than
     * typed in by the user.
     */
    async CC_AUTH_PROFILE() {
        return readSignedInUser();
    },

    /** Liveness + "are we currently blocked / signed in?" probe. */
    async CC_HISTORY_STATUS() {
        if (isChallengeDocument()) {
            return { ok: true, challenged: true, signedIn: false, username: null };
        }
        const user = await readSignedInUser();
        if (!user.ok) return user;
        return { ok: true, challenged: false, signedIn: Boolean(user.signedIn), username: user.username || null };
    },

    async CC_HISTORY_PAGE({ handle, page }) {
        return fetchRecentPage(handle, page);
    },

    /**
     * Returns a submission's source *and* its problem's metadata in one round
     * trip, so the import does not need a second RPC per problem.
     */
    async CC_HISTORY_SOURCE({ submissionId, problemCode, contestCode }) {
        const source = await requestSubmissionSource(submissionId);
        if (!source.code) return source;

        const meta = await fetchProblemMeta(problemCode, contestCode);
        return { ...source, meta: meta || null };
    }
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handler = request && rpcHandlers[request.type];
    if (!handler) return;

    handler(request)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message || String(error) }));

    // Keep the channel open for the async handler above.
    return true;
});

/* ------------------------------------------------------------------ */

async function startPolling() {
    const user = await readSignedInUser();
    if (!user.ok || !user.signedIn) {
        console.log('AlgoPush: not signed in to CodeChef — live sync is idle until you sign in.');
        return;
    }

    currentHandle = user.username;
    console.log('AlgoPush: found CodeChef handle:', currentHandle);

    // Seed the processed set and clear anything the service worker queued
    // while no CodeChef tab was open, then watch for new submissions.
    pollSubmissions()
        .then(drainPendingSubmissions)
        .catch(error => console.warn('AlgoPush: CodeChef startup pass failed.', error));

    setInterval(() => {
        if (document.visibilityState === 'visible') {
            pollSubmissions().catch(error => console.warn('AlgoPush: CodeChef poll failed.', error));
        }
    }, POLL_INTERVAL_MS);
}

// The dedicated historical-import tab only answers RPCs; letting it poll too
// would race the import for the same submissions.
if (!IS_HISTORY_TAB) {
    startPolling();
}
