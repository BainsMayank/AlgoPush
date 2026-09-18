// Content script for AtCoder
//
// AtCoder is the strictest of the three platforms about where a request may
// come from: every submissions page and every submission's source is behind
// the login session, and a request that isn't one made by the signed-in
// browser gets a 302 to /login. So everything here runs same-origin from a
// real atcoder.jp page, the same way the Codeforces and LeetCode scripts do —
// the user's password never goes near the extension, and no credentials are
// stored anywhere.

console.log('AlgoPush: AtCoder content script loaded.');

const HISTORY_HASH = '#algopush-history';
const IS_HISTORY_TAB = location.hash === HISTORY_HASH;

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * Returns the signed-in user's screen name, or null when signed out.
 *
 * Every AtCoder page declares `var userScreenName = "..."` for its own
 * scripts, and it is empty exactly when nobody is signed in — an
 * authoritative answer from AtCoder itself, not a guess from the DOM. The
 * navbar link is kept as a fallback in case that variable is ever renamed.
 *
 * The fallback is scoped to the navbar on purpose: a standings or submissions
 * page is full of *other* people's /users/ links, and picking the first one
 * on the page would mean syncing under a stranger's account.
 */
function getScreenName() {
    const declared = document.documentElement.innerHTML.match(/userScreenName\s*=\s*["']([^"']*)["']/);
    if (declared) return declared[1] || null;

    const link = document.querySelector('.navbar a.username, .navbar-right a[href^="/users/"], #navbar-collapse a[href^="/users/"]');
    const match = link && link.getAttribute('href').match(/^\/users\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

function isSignedIn() {
    return Boolean(getScreenName());
}

/* ------------------------------------------------------------------ *
 * Same-origin page fetching
 *
 * AtCoder answers a signed-out request for anything submission-related with a
 * 302 to /login rather than a 401/403, so "you are signed out" has to be
 * recognised from where we landed, not from a status code.
 * ------------------------------------------------------------------ */

/**
 * Fetches an AtCoder page and parses it.
 *
 * Returns exactly one of:
 *   { doc }                     — success
 *   { signedOut: true, error }  — AtCoder bounced us to the login page
 *   { retryable: true, error }  — throttling or a server-side hiccup
 *   { error }                   — permanent for this request
 */
async function fetchAtCoderDocument(path) {
    let response;
    try {
        response = await fetch(path, { credentials: 'same-origin', redirect: 'follow' });
    } catch (e) {
        return { retryable: true, error: `Network error contacting AtCoder: ${e.message}` };
    }

    if (/\/login\b/.test(new URL(response.url, location.origin).pathname)) {
        return { signedOut: true, error: 'AtCoder redirected to its sign-in page — the session has expired.' };
    }
    if (response.status === 429 || response.status >= 500) {
        return { retryable: true, error: `AtCoder is throttling or unavailable (HTTP ${response.status}).` };
    }
    if (response.status === 404) {
        return { error: `AtCoder has no page at ${path}.` };
    }
    if (!response.ok) {
        return { error: `AtCoder returned HTTP ${response.status} for ${path}.` };
    }

    const html = await response.text().catch(() => '');
    if (!html) return { retryable: true, error: 'AtCoder returned an empty response.' };

    const doc = new DOMParser().parseFromString(html, 'text/html');

    // A soft bounce: the page loaded, but it is the sign-in form.
    if (/userScreenName\s*=\s*["']["']/.test(html) && doc.querySelector('form[action^="/login"]')) {
        return { signedOut: true, error: 'AtCoder served its sign-in page — the session has expired.' };
    }

    return { doc };
}

/* ------------------------------------------------------------------ *
 * Table parsing
 *
 * Both AtCoder tables are read by *column heading* rather than by column
 * index. AtCoder shows different columns in different places — a contest
 * still running hides Exec Time and Memory, and the site is bilingual — so a
 * hard-coded "language is the 4th cell" breaks in ordinary use. Matching the
 * heading text (in both languages) does not.
 * ------------------------------------------------------------------ */

const COLUMN_LABELS = {
    task: ['task', '問題'],
    language: ['language', '言語'],
    status: ['status', '結果'],
    time: ['submission time', '提出日時']
};

function matchesLabel(text, labels) {
    const normalized = String(text || '').trim().toLowerCase();
    return labels.some(label => normalized === label || normalized.startsWith(label));
}

/** Maps our column names to indices for one table, from its <th> row. */
function mapColumns(table) {
    const headers = Array.from(table.querySelectorAll('thead th'));
    const columns = {};
    headers.forEach((header, index) => {
        for (const [name, labels] of Object.entries(COLUMN_LABELS)) {
            if (columns[name] === undefined && matchesLabel(header.textContent, labels)) {
                columns[name] = index;
            }
        }
    });
    return columns;
}

function cellText(cells, index) {
    const cell = index === undefined ? null : cells[index];
    return cell ? cell.textContent.trim() : '';
}

/**
 * Extracts the Accepted submissions from a submissions listing page.
 *
 * The verdict is read from the status column's own text rather than from the
 * `label-success` CSS class: a submission still being judged also renders
 * green partway through ("12/40 AC"), and syncing a half-judged submission
 * would push code that is about to be rejected.
 */
function parseSubmissionRows(doc) {
    const rows = [];

    for (const table of doc.querySelectorAll('table')) {
        const columns = mapColumns(table);
        if (columns.task === undefined || columns.status === undefined) continue;

        for (const row of table.querySelectorAll('tbody tr')) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (!cells.length) continue;

            if (cellText(cells, columns.status).toUpperCase() !== 'AC') continue;

            const taskLink = row.querySelector('a[href*="/tasks/"]');
            if (!taskLink) continue;

            // Not `querySelector('a[href*="/submissions/"]')`: the language
            // cell links to a filtered submissions list too, and taking the
            // first anchor that merely mentions submissions would read a
            // filter URL instead of the submission's own id.
            const idMatch = Array.from(row.querySelectorAll('a[href]'))
                .map(link => link.getAttribute('href').match(/\/submissions\/(\d+)/))
                .find(Boolean);

            const taskMatch = taskLink.getAttribute('href').match(/\/contests\/([^/]+)\/tasks\/([^/?#]+)/);
            if (!taskMatch || !idMatch) continue;

            const timeCell = columns.time === undefined ? null : cells[columns.time];
            const timeText = timeCell && timeCell.querySelector('time');

            rows.push({
                id: Number(idMatch[1]),
                contestId: taskMatch[1],
                problemId: taskMatch[2],
                // "A - Welcome to AtCoder" — the problem's own name is the
                // half after the index letter.
                taskTitle: taskLink.textContent.trim().replace(/^[^-]{1,4}\s+-\s+/, ''),
                language: cellText(cells, columns.language),
                submittedAt: timeText ? timeText.textContent.trim() : ''
            });
        }
    }

    return rows;
}

/**
 * Reads the source code and language off a submission detail page.
 *
 * `#submission-code` is AtCoder's own id for the source block and has been
 * stable for years; the others are defensive fallbacks.
 */
function parseSubmissionDetail(doc) {
    const selectors = ['#submission-code', 'pre.prettyprint.linenums', '.panel-body pre', 'pre.prettyprint'];
    let code = null;
    for (const selector of selectors) {
        const element = doc.querySelector(selector);
        const text = element && (element.textContent || '');
        if (text && text.trim()) {
            code = text.replace(/\r\n/g, '\n');
            break;
        }
    }

    // The info table is label-driven for the same reason the listing is.
    let language = '';
    for (const row of doc.querySelectorAll('tr')) {
        const header = row.querySelector('th');
        const value = row.querySelector('td');
        if (header && value && matchesLabel(header.textContent, COLUMN_LABELS.language)) {
            language = value.textContent.trim();
            break;
        }
    }

    const taskLink = doc.querySelector('a[href*="/tasks/"]');
    const taskMatch = taskLink && taskLink.getAttribute('href').match(/\/contests\/([^/]+)\/tasks\/([^/?#]+)/);

    return {
        code,
        language,
        contestId: taskMatch ? taskMatch[1] : '',
        problemId: taskMatch ? taskMatch[2] : '',
        taskTitle: taskLink ? taskLink.textContent.trim().replace(/^[^-]{1,4}\s+-\s+/, '') : ''
    };
}

/**
 * Fetches one submission's source.
 *
 * Returns the same result shape as the Codeforces equivalent, so the shared
 * historical-import engine can treat both platforms identically.
 */
async function requestSubmissionSource(contestId, submissionId) {
    // The page the user is already looking at needs no request at all.
    const onPage = location.pathname.match(/\/contests\/([^/]+)\/submissions\/(\d+)/);
    if (onPage && Number(onPage[2]) === Number(submissionId)) {
        const rendered = parseSubmissionDetail(document);
        if (rendered.code) return { code: rendered.code, language: rendered.language };
    }

    const result = await fetchAtCoderDocument(`/contests/${encodeURIComponent(contestId)}/submissions/${encodeURIComponent(submissionId)}`);
    if (!result.doc) return result;

    const detail = parseSubmissionDetail(result.doc);
    if (!detail.code) {
        return { error: `AtCoder returned no source for submission ${submissionId}. Source is only visible once the contest has ended.` };
    }
    return { code: detail.code, language: detail.language };
}

/* ------------------------------------------------------------------ *
 * Live sync
 *
 * AtCoder has no cross-contest "my submissions" page — the listing is always
 * contest-scoped — so the live poller watches the contest whose page the user
 * is currently on. That is not a limitation in practice: it is exactly the
 * page AtCoder redirects you to after you submit.
 *
 * Anything this misses (submitted, then the tab closed before the judge
 * finished) is caught by the service worker's catch-up pass instead.
 * ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 7000;
const PROCESSED_LIMIT = 200;

function getContestIdFromPage() {
    const match = location.pathname.match(/^\/contests\/([^/]+)/);
    return match ? match[1] : null;
}

async function sendAcceptedSubmission(row, code, language) {
    return chrome.runtime.sendMessage({
        type: 'SUBMISSION_ACCEPTED',
        platform: 'AtCoder',
        submissionId: row.id,
        title: row.taskTitle,
        slug: `${row.contestId}/${row.problemId}`,
        contestId: row.contestId,
        problemId: row.problemId,
        // Difficulty and the contest-series tag are filled in by the service
        // worker from the AtCoder Problems catalog — see
        // shared/atcoder-catalog.js.
        difficulty: 'Unknown',
        tags: [],
        code,
        language: language || row.language || 'Unknown'
    });
}

/**
 * Resolves the "live sync starts here" watermark, shared with the service
 * worker's catch-up pass so the two can never disagree about which
 * submissions predate the install.
 *
 * This page can only ever see one contest's submissions, so the highest id it
 * can observe is a *contest-local* maximum — writing that as the watermark
 * would leave every more-recent submission from every other contest looking
 * new, and the catch-up pass would dutifully backfill them. So when an
 * account is connected the service worker sets it instead, from the full
 * submission history; the local maximum is only used when nothing is
 * connected, in which case the catch-up pass is dormant and there is no
 * second opinion to contradict.
 */
async function ensureWatermark(localHighest) {
    const { acProfile, acWatermarkSubmissionId = null } =
        await chrome.storage.local.get(['acProfile', 'acWatermarkSubmissionId']);

    if (acWatermarkSubmissionId !== null) return acWatermarkSubmissionId;

    if (acProfile && acProfile.username) {
        try {
            await chrome.runtime.sendMessage({ type: 'AC_ENSURE_WATERMARK' });
        } catch (error) {
            console.warn('AlgoPush: could not establish the AtCoder sync watermark yet.', error);
        }
        const { acWatermarkSubmissionId: settled = null } = await chrome.storage.local.get('acWatermarkSubmissionId');
        return settled;
    }

    await chrome.storage.local.set({ acWatermarkSubmissionId: localHighest });
    return localHighest;
}

async function pollSubmissions() {
    const contestId = getContestIdFromPage();
    if (!contestId || !isSignedIn()) return;

    const listing = await fetchAtCoderDocument(`/contests/${encodeURIComponent(contestId)}/submissions/me?f.Status=AC`);
    if (!listing.doc) return;

    const submissions = parseSubmissionRows(listing.doc);
    if (!submissions.length) return;

    const { acProcessedSubmissions = null } = await chrome.storage.local.get('acProcessedSubmissions');
    const highest = submissions.reduce((max, row) => Math.max(max, row.id), 0);

    // First run on this machine: everything already on screen predates the
    // install and belongs to the historical import, not to a surprise
    // backfill.
    if (acProcessedSubmissions === null) {
        await chrome.storage.local.set({
            acProcessedSubmissions: submissions.map(row => row.id).slice(-PROCESSED_LIMIT)
        });
    }

    const watermark = await ensureWatermark(highest);

    // Undecidable for now — syncing anything here risks backfilling an old
    // contest the user just happened to open. The next poll tries again.
    if (watermark === null) return;

    const processed = new Set(acProcessedSubmissions || submissions.map(row => row.id));

    for (const row of submissions) {
        if (row.id <= watermark || processed.has(row.id)) continue;

        console.log('AlgoPush: detected a new accepted submission on AtCoder.', row.id);

        const source = await requestSubmissionSource(row.contestId, row.id);
        if (!source.code) {
            // Leave it unprocessed so the next poll retries, rather than
            // silently dropping an Accepted submission.
            console.warn(`AlgoPush: could not read source for ${row.id}: ${source.error}`);
            continue;
        }

        const syncResult = await sendAcceptedSubmission(row, source.code, source.language);
        if (!syncResult || !syncResult.ok) {
            console.error('AlgoPush: GitHub sync failed:', syncResult && syncResult.error);
            continue;
        }

        // Re-read rather than mutating a stale copy: the pending drain below
        // writes this same key.
        const { acProcessedSubmissions: done = [] } = await chrome.storage.local.get('acProcessedSubmissions');
        await chrome.storage.local.set({ acProcessedSubmissions: [...done, row.id].slice(-PROCESSED_LIMIT) });
        processed.add(row.id);
    }
}

/**
 * Pushes submissions the service worker's catch-up pass found while no
 * AtCoder tab was open.
 *
 * The service worker can *detect* a missed Accepted submission without a tab,
 * but it cannot read the source — AtCoder only serves that to the signed-in
 * session. So it leaves them in `acPendingSubmissions` and this drains the
 * queue from the first AtCoder page that loads. An item is only removed once
 * GitHub has confirmed the push, so a failure means a retry on the next page
 * load rather than a loss.
 */
const drainLock = createDrainLock('acDrainLock');

async function drainPendingSubmissions() {
    const { acPendingSubmissions = [] } = await chrome.storage.local.get('acPendingSubmissions');
    if (acPendingSubmissions.length === 0) return;
    if (!(await drainLock.acquire())) return;

    console.log(`AlgoPush: draining ${acPendingSubmissions.length} missed AtCoder submission(s).`);

    try {
        for (const item of acPendingSubmissions) {
            const source = await requestSubmissionSource(item.contestId, item.id);
            if (!source.code) {
                // Signed out or throttled — keep the rest queued rather than
                // burning through them all against a wall.
                console.warn(`AlgoPush: could not read source for missed submission ${item.id}: ${source.error}`);
                break;
            }

            const syncResult = await chrome.runtime.sendMessage({
                type: 'SUBMISSION_ACCEPTED',
                platform: 'AtCoder',
                submissionId: item.id,
                title: item.title,
                slug: `${item.contestId}/${item.problemId}`,
                contestId: item.contestId,
                problemId: item.problemId,
                difficulty: 'Unknown',
                tags: [],
                code: source.code,
                language: item.language || source.language || 'Unknown'
            });

            if (!syncResult || !syncResult.ok) {
                console.error('AlgoPush: GitHub sync failed for missed submission:', syncResult && syncResult.error);
                break;
            }

            const { acPendingSubmissions: queue = [], acProcessedSubmissions: done = [] } =
                await chrome.storage.local.get(['acPendingSubmissions', 'acProcessedSubmissions']);
            await chrome.storage.local.set({
                acPendingSubmissions: queue.filter(entry => entry.id !== item.id),
                acProcessedSubmissions: [...done, item.id].slice(-PROCESSED_LIMIT)
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
 * Used by the one-click connect (shared/atcoder-auth.js) and by the
 * historical import (options/options.js), both of which drive a single
 * background atcoder.jp tab.
 * ------------------------------------------------------------------ */

const rpcHandlers = {
    /**
     * Answers "which AtCoder account is this browser?" — the one thing the
     * Connect button needs, straight from AtCoder's own session rather than
     * typed in by the user.
     */
    async AC_AUTH_PROFILE() {
        const screenName = getScreenName();
        if (!screenName) return { ok: true, signedIn: false };

        const profile = { ok: true, signedIn: true, username: screenName, rating: null };

        // Rating is a cosmetic flourish for the connected card, so a failure
        // here must not cost the user a connection they already completed.
        try {
            const response = await fetch(`/users/${encodeURIComponent(screenName)}/history/json`, { credentials: 'same-origin' });
            if (response.ok) {
                const history = await response.json();
                if (Array.isArray(history) && history.length) {
                    profile.rating = history[history.length - 1].NewRating ?? null;
                }
            }
        } catch (error) {
            console.warn('AlgoPush: could not read the AtCoder rating history.', error);
        }

        return profile;
    },

    async AC_HISTORY_STATUS() {
        return { ok: true, signedIn: isSignedIn(), username: getScreenName() };
    },

    async AC_HISTORY_SOURCE({ contestId, submissionId }) {
        return requestSubmissionSource(contestId, submissionId);
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

function startPolling() {
    if (!isSignedIn()) {
        console.log('AlgoPush: not signed in to AtCoder — live sync is idle until you sign in.');
        return;
    }

    // Seed the processed set and clear anything the service worker queued
    // while no AtCoder tab was open, then watch this contest.
    pollSubmissions()
        .then(drainPendingSubmissions)
        .catch(error => console.warn('AlgoPush: AtCoder startup pass failed.', error));

    if (!getContestIdFromPage()) return;

    setInterval(() => {
        if (document.visibilityState === 'visible') {
            pollSubmissions().catch(error => console.warn('AlgoPush: AtCoder poll failed.', error));
        }
    }, POLL_INTERVAL_MS);
}

// The dedicated historical-import tab only answers RPCs; letting it poll too
// would race the import for the same submissions.
if (!IS_HISTORY_TAB) {
    startPolling();
}
