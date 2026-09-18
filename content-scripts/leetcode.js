// Content script for LeetCode

console.log("AlgoPush: LeetCode content script loaded.");

const processedSubmissions = new Set();

const HISTORY_HASH = '#algopush-history';
const IS_HISTORY_TAB = location.hash === HISTORY_HASH;

const LEETCODE_GRAPHQL = '/graphql';

/**
 * Carries whether a failure is worth retrying, so the historical importer can
 * back off through LeetCode's rate limiter instead of writing the whole run
 * off as failed — GraphQL throttling (429) is by far the most common thing a
 * few hundred sequential lookups run into.
 */
class LeetCodeRequestError extends Error {
    constructor(message, { retryable = false, status = 0 } = {}) {
        super(message);
        this.name = 'LeetCodeRequestError';
        this.retryable = retryable;
        this.status = status;
    }
}

function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

async function leetGraphQL(query, variables, operationName) {
    const csrfToken = getCsrfToken();

    let response;
    try {
        response = await fetch(LEETCODE_GRAPHQL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                ...(csrfToken ? { 'x-csrftoken': csrfToken } : {})
            },
            body: JSON.stringify({ query, variables, operationName })
        });
    } catch (e) {
        throw new LeetCodeRequestError(`Network error contacting LeetCode: ${e.message}`, { retryable: true });
    }

    if (response.status === 429) {
        throw new LeetCodeRequestError('LeetCode is rate-limiting requests.', { retryable: true, status: 429 });
    }
    if (response.status === 403 || response.status === 401) {
        throw new LeetCodeRequestError('LeetCode rejected the request — your session may have expired. Sign in to leetcode.com again.', { status: response.status });
    }
    if (response.status >= 500) {
        throw new LeetCodeRequestError(`LeetCode is unavailable (HTTP ${response.status}).`, { retryable: true, status: response.status });
    }

    let json;
    try {
        json = await response.json();
    } catch (_) {
        throw new LeetCodeRequestError('LeetCode returned an unexpected (non-JSON) response.', { retryable: true, status: response.status });
    }

    if (!response.ok || json.errors) {
        throw new LeetCodeRequestError(
            json.errors?.[0]?.message || `LeetCode request failed (HTTP ${response.status}).`,
            { status: response.status }
        );
    }
    return json.data;
}

const QUESTION_LIST_QUERY = `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) { problemsetQuestionList: questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) { total: totalNum questions: data { title titleSlug difficulty status topicTags { name } } } }`;

function isAccepted(question) {
    return String(question.status || '').toLowerCase() === 'ac';
}

/**
 * Lists every solved problem.
 *
 * Asks LeetCode to filter server-side (`status: "AC"`), which turns a full
 * walk of the ~3,500-problem problemset into a handful of pages. The
 * unfiltered walk is kept as a fallback because that filter argument has
 * changed shape across LeetCode's GraphQL revisions, and a schema change
 * should degrade to "slow" rather than "broken".
 */
async function getLeetCodeQuestions() {
    for (const filters of [{ status: 'AC' }, {}]) {
        const questions = [];
        let skip = 0;
        let total = Infinity;

        try {
            // Hard page cap: a malformed `total` must not spin forever.
            for (let page = 0; page < 60 && skip < total; page++) {
                const data = await leetGraphQL(QUESTION_LIST_QUERY, { categorySlug: '', limit: 100, skip, filters }, 'problemsetQuestionList');
                const listing = data.problemsetQuestionList;
                total = listing?.total ?? 0;
                const items = listing?.questions || [];
                questions.push(...items.filter(isAccepted));
                if (!items.length) break;
                skip += items.length;
            }
            return questions;
        } catch (error) {
            if (error.retryable) throw error;          // throttling — don't burn the fallback on it
            console.warn('AlgoPush: LeetCode question listing failed, trying the unfiltered fallback.', error);
        }
    }

    throw new LeetCodeRequestError('LeetCode would not return your solved problems.');
}

const SUBMISSION_LIST_QUERY = `query submissions($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String!) { submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) { submissions { id statusDisplay } } }`;
const SUBMISSION_DETAIL_QUERY = `query submissionDetails($submissionId: Int!) { submissionDetails(submissionId: $submissionId) { code lang { name } } }`;

/**
 * Resolves one solved problem to a ready-to-push submission payload.
 *
 * Returns { submission } on success, or { error, retryable } — never a bare
 * null, because "this problem has no retrievable accepted submission" (it
 * happens: very old submissions lose their stored code) must be reported
 * rather than silently dropped from the tally.
 */
async function getLeetCodeSubmission(question) {
    try {
        const list = await leetGraphQL(SUBMISSION_LIST_QUERY, { offset: 0, limit: 20, lastKey: null, questionSlug: question.titleSlug }, 'submissions');
        const accepted = list.submissionList?.submissions?.find(item => item.statusDisplay === 'Accepted');
        if (!accepted) {
            return { error: `LeetCode lists no accepted submission for "${question.title}".` };
        }

        const detail = await leetGraphQL(SUBMISSION_DETAIL_QUERY, { submissionId: Number(accepted.id) }, 'submissionDetails');
        const code = detail.submissionDetails?.code;
        if (!code || !code.trim()) {
            return { error: `LeetCode returned no source code for "${question.title}".` };
        }

        return {
            submission: {
                type: 'SUBMISSION_ACCEPTED',
                platform: 'LeetCode',
                submissionId: accepted.id,
                title: question.title,
                slug: question.titleSlug,
                difficulty: question.difficulty || 'Unknown',
                tags: (question.topicTags || []).map(tag => tag.name),
                code,
                language: detail.submissionDetails.lang?.name || 'Unknown'
            }
        };
    } catch (error) {
        return { error: error.message || String(error), retryable: Boolean(error.retryable) };
    }
}

/* ------------------------------------------------------------------ *
 * Historical-import RPC surface
 *
 * The options page drives the whole import through these messages against a
 * single, already-loaded LeetCode tab, so every request carries the real
 * session cookie and CSRF token from a genuine page context.
 * ------------------------------------------------------------------ */

const GLOBAL_DATA_QUERY = `query globalData { userStatus { isSignedIn username realName avatar } }`;
const PUBLIC_PROFILE_QUERY = `query userPublicProfile($username: String!) { matchedUser(username: $username) { profile { ranking userAvatar realName } } }`;

const historyHandlers = {
    /**
     * Answers "which LeetCode account is this browser?" — the one thing the
     * options page's Connect button needs, straight from LeetCode's own
     * session rather than typed in by the user. See shared/leetcode-auth.js
     * for why this stands in for an OAuth login.
     */
    async LC_AUTH_PROFILE() {
        try {
            const data = await leetGraphQL(GLOBAL_DATA_QUERY, {}, 'globalData');
            const userStatus = data.userStatus || {};

            if (!userStatus.isSignedIn) {
                return { ok: true, signedIn: false };
            }

            const profile = {
                ok: true,
                signedIn: true,
                username: userStatus.username || null,
                realName: userStatus.realName || null,
                avatar: userStatus.avatar || null,
                ranking: null
            };

            // Rating-equivalent flourish for the connected card. Purely
            // cosmetic, and a separate query, so a failure here must not cost
            // the user a connection they have already completed.
            if (profile.username) {
                try {
                    const extra = await leetGraphQL(PUBLIC_PROFILE_QUERY, { username: profile.username }, 'userPublicProfile');
                    const matched = extra.matchedUser?.profile;
                    if (matched) {
                        profile.ranking = matched.ranking ?? null;
                        profile.avatar = profile.avatar || matched.userAvatar || null;
                        profile.realName = profile.realName || matched.realName || null;
                    }
                } catch (error) {
                    console.warn('AlgoPush: could not read the LeetCode public profile.', error);
                }
            }

            return profile;
        } catch (error) {
            return { ok: false, retryable: Boolean(error.retryable), error: error.message || String(error) };
        }
    },

    async LC_HISTORY_STATUS() {
        try {
            const data = await leetGraphQL(GLOBAL_DATA_QUERY, {}, 'globalData');
            const userStatus = data.userStatus || {};
            return { ok: true, signedIn: Boolean(userStatus.isSignedIn), username: userStatus.username || null };
        } catch (error) {
            return { ok: false, retryable: Boolean(error.retryable), error: error.message || String(error) };
        }
    },

    async LC_HISTORY_QUESTIONS() {
        try {
            return { ok: true, questions: await getLeetCodeQuestions() };
        } catch (error) {
            return { ok: false, retryable: Boolean(error.retryable), error: error.message || String(error) };
        }
    },

    async LC_HISTORY_SUBMISSION({ question }) {
        return getLeetCodeSubmission(question);
    }
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handler = request && historyHandlers[request.type];
    if (!handler) return;

    handler(request)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message || String(error) }));

    // Keep the channel open for the async handler above.
    return true;
});

// 1. Inject the interceptor script into the main world
const script = document.createElement('script');
script.src = chrome.runtime.getURL('content-scripts/leetcode-inject.js');
script.onload = function() {
    this.remove(); // Clean up after injection
};
(document.head || document.documentElement).appendChild(script);

// 2. Listen for messages from the injected script
window.addEventListener('message', async (event) => {
    // Same window, same origin, and our specific type. The origin check
    // matters: whatever arrives here is turned into a commit in the user's
    // repository, so an unchecked listener lets anything that can post a
    // message on this page choose the file contents.
    if (event.source !== window || event.origin !== window.location.origin) {
        return;
    }
    if (!event.data || event.data.type !== 'LEETCODE_SUBMISSION_ACCEPTED') {
        return;
    }

    const { submissionId, code, lang } = event.data;

    // Avoid duplicate processing for the same submission ID in a single session
    if (processedSubmissions.has(submissionId)) {
        return;
    }
    processedSubmissions.add(submissionId);
    
    console.log("AlgoPush: Detected accepted submission!", submissionId);

    // 3. Extract problem details via GraphQL to ensure reliability against DOM changes
    const pathname = window.location.pathname;
    const slugMatch = pathname.match(/\/problems\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : 'unknown';

    const details = await fetchProblemDetails(slug);

    const submission = {
        type: 'SUBMISSION_ACCEPTED',
        platform: 'LeetCode',
        submissionId: submissionId,
        title: details.title || slug,
        slug: slug,
        difficulty: details.difficulty || 'Unknown',
        tags: details.tags || [],
        code: code,
        language: lang
    };

    // 4. Send the extracted data to the background script.
    //
    // The result has to be awaited. This event fires exactly once, from a
    // page the user is about to navigate away from — so a push that fails
    // (GitHub rate limit, expired token, no repo chosen yet) has no second
    // chance the way a poll-based platform does. Codeforces and AtCoder both
    // queue a failure for retry; without this LeetCode silently lost the
    // submission instead.
    let syncResult = null;
    try {
        syncResult = await chrome.runtime.sendMessage(submission);
    } catch (error) {
        console.error('AlgoPush: could not reach the AlgoPush background worker.', error);
    }

    if (!syncResult || !syncResult.ok) {
        console.error('AlgoPush: GitHub sync failed:', syncResult && syncResult.error);
        processedSubmissions.delete(submissionId);
        await queuePendingSubmission(submission);
    }
});

/* ------------------------------------------------------------------ *
 * Retry queue
 *
 * The other two platforms recover a failed push by re-reading the source
 * from the site on the next page load. LeetCode's live path cannot: the code
 * arrives from an intercepted in-page request that happens once. So the
 * payload itself is persisted, and drained from the next LeetCode page.
 * ------------------------------------------------------------------ */

const LC_PENDING_LIMIT = 25;
const drainLock = createDrainLock('lcDrainLock');

async function queuePendingSubmission(submission) {
    const { lcPendingSubmissions = [] } = await chrome.storage.local.get('lcPendingSubmissions');
    if (lcPendingSubmissions.some(item => item.submissionId === submission.submissionId)) return;

    await chrome.storage.local.set({
        lcPendingSubmissions: [...lcPendingSubmissions, submission].slice(-LC_PENDING_LIMIT)
    });
    console.warn(`AlgoPush: queued "${submission.title}" for retry on the next LeetCode page load.`);
}

async function drainPendingSubmissions() {
    const { lcPendingSubmissions = [] } = await chrome.storage.local.get('lcPendingSubmissions');
    if (lcPendingSubmissions.length === 0) return;
    if (!(await drainLock.acquire())) return;

    console.log(`AlgoPush: retrying ${lcPendingSubmissions.length} LeetCode submission(s).`);

    try {
        for (const submission of lcPendingSubmissions) {
            let result = null;
            try {
                result = await chrome.runtime.sendMessage(submission);
            } catch (error) {
                console.error('AlgoPush: could not reach the AlgoPush background worker.', error);
            }

            if (!result || !result.ok) {
                // Still failing — leave this and everything after it queued.
                console.warn('AlgoPush: LeetCode retry still failing:', result && result.error);
                break;
            }

            const { lcPendingSubmissions: queue = [] } = await chrome.storage.local.get('lcPendingSubmissions');
            await chrome.storage.local.set({
                lcPendingSubmissions: queue.filter(item => item.submissionId !== submission.submissionId)
            });
        }
    } finally {
        await drainLock.release();
    }
}

// The dedicated history-import tab only answers RPCs; it must not also be
// retrying pushes underneath a run that is already driving it.
if (!IS_HISTORY_TAB) {
    drainPendingSubmissions();
}

/**
 * Fetches problem metadata (title, difficulty, tags) for a live submission.
 *
 * Retries, because the consequence of giving up is not cosmetic: a push with
 * difficulty 'Unknown' files the problem under `LeetCode/Uncategorized/`,
 * which is a *different folder* from the one the historical import uses for
 * the same problem. Going through leetGraphQL (rather than a bare fetch) also
 * means the CSRF token is sent and throttling is recognised as retryable
 * instead of being mistaken for a permanent failure.
 *
 * If it still fails, difficulty is left as 'Unknown' and the service worker
 * falls back to whatever it already knows about this problem.
 */
const QUESTION_DATA_QUERY = `query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { title difficulty topicTags { name } } }`;

async function fetchProblemDetails(slug) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const data = await leetGraphQL(QUESTION_DATA_QUERY, { titleSlug: slug }, 'questionData');
            const question = data.question;
            if (question) {
                return {
                    title: question.title,
                    difficulty: question.difficulty,
                    tags: (question.topicTags || []).map(tag => tag.name)
                };
            }
        } catch (error) {
            console.warn(`AlgoPush: LeetCode metadata lookup failed for "${slug}" (attempt ${attempt + 1}/3).`, error);
            if (!error.retryable) break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }

    console.error(`AlgoPush: giving up on LeetCode metadata for "${slug}"; the sync falls back to what it already knows.`);
    return {
        title: document.title.split('-')[0].trim(),
        difficulty: 'Unknown',
        tags: []
    };
}
