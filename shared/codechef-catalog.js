// CodeChef problem catalog — titles, difficulty and topic tags.
//
// Unlike AtCoder, CodeChef does publish this itself: every problem answers
// `/api/contests/<contest>/problems/<code>` with its display name, its
// `difficulty_rating`, and both tag sets the site shows. So there is no
// community dataset to mirror here and nothing to download in bulk — the one
// thing worth adding is a cache, because a historical import asks about a few
// hundred problems and a re-run would otherwise ask again.
//
// It is deliberately *only* metadata. Submission source code never comes from
// here — that is read from codechef.com itself, through the user's own
// signed-in session, exactly as the Codeforces, LeetCode and AtCoder paths do.
//
// Both callers go through the same cache — the service worker enriching a
// submission on its way to GitHub, and the options page listing a historical
// import — so a live push and a bulk import always agree on a problem's title,
// folder and difficulty.

const CACHE_KEY = 'ccProblemCatalog';
// Problem metadata is essentially static once a problem is published; the one
// field that does move (difficulty_rating) drifts over weeks, not hours.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * CodeChef states problem difficulty as a rating in roughly the 100–5000
 * range. Filing one folder per rating value would scatter a few hundred
 * solutions across a few hundred folders, so ratings are bucketed into the
 * five names CodeChef has always used for its own practice sections — the
 * vocabulary a CodeChef user already has for "how hard was that".
 */
const DIFFICULTY_BANDS = [
    { max: 1000, name: 'Beginner' },
    { max: 1400, name: 'Easy' },
    { max: 1800, name: 'Medium' },
    { max: 2200, name: 'Hard' },
    { max: Infinity, name: 'Challenge' }
];

/**
 * Normalizes what the API reports as a difficulty.
 *
 * `difficulty_rating` arrives as a *string*, and is "-1" for a problem that
 * has not been rated yet — which is not a difficulty of minus one, it is the
 * absence of one.
 */
export function parseDifficultyRating(raw) {
    const rating = Number(raw);
    if (!Number.isFinite(rating) || rating <= 0) return null;
    return Math.round(rating);
}

export function difficultyBand(rating) {
    if (rating === null || rating === undefined) return 'Unknown';
    return DIFFICULTY_BANDS.find(band => rating < band.max).name;
}

/**
 * The canonical link to a CodeChef problem.
 *
 * A problem first posed in a contest keeps working under its contest path
 * *and* under the bare practice path, so the bare one is a safe fallback when
 * the contest a submission belongs to isn't known.
 */
export function codechefProblemUrl(problemCode, contestCode) {
    const code = encodeURIComponent(String(problemCode || ''));
    if (contestCode && contestCode !== 'PRACTICE') {
        return `https://www.codechef.com/${encodeURIComponent(contestCode)}/problems/${code}`;
    }
    return `https://www.codechef.com/problems/${code}`;
}

/**
 * Picks the tag list worth filing a solution under.
 *
 * CodeChef publishes two: `user_tags` are the topical ones a reader thinks in
 * ("Trees", "Greedy", "Basic Math"), and `computed_tags` are the broad
 * category ("Algorithms", "Data Structures"). The topical set is what makes
 * the repo's index useful, so it wins; the broad set is the fallback for a
 * problem nobody has tagged yet.
 */
function pickTags(payload) {
    const userTags = Array.isArray(payload.user_tags) ? payload.user_tags.filter(Boolean) : [];
    if (userTags.length) return userTags;
    const computed = Array.isArray(payload.computed_tags) ? payload.computed_tags.filter(Boolean) : [];
    return computed;
}

async function fetchProblemPayload(problemCode, contestCode) {
    // The contest the problem was posed in first, then the practice section.
    // Order matters: a contest problem answers under its own contest code and
    // 404s (as `{"status":"error"}`) under PRACTICE, while a pure practice
    // problem only answers under PRACTICE.
    const contests = [];
    if (contestCode && contestCode !== 'PRACTICE') contests.push(contestCode);
    contests.push('PRACTICE');

    let lastError = null;

    for (const contest of contests) {
        const url = `https://www.codechef.com/api/contests/${encodeURIComponent(contest)}/problems/${encodeURIComponent(problemCode)}`;
        let response;
        try {
            response = await fetch(url, { credentials: 'omit' });
        } catch (error) {
            lastError = error;
            continue;
        }

        if (!response.ok) {
            lastError = new Error(`CodeChef returned HTTP ${response.status} for problem ${problemCode}.`);
            continue;
        }

        let payload;
        try {
            payload = await response.json();
        } catch (_) {
            lastError = new Error(`CodeChef returned an unexpected response for problem ${problemCode}.`);
            continue;
        }

        if (payload && payload.status === 'success') return payload;
        lastError = new Error(payload && payload.message ? payload.message : `CodeChef has no metadata for ${problemCode}.`);
    }

    throw lastError || new Error(`CodeChef has no metadata for ${problemCode}.`);
}

/** In-memory cache, so repeated lookups inside one run don't re-read storage. */
const memoryCatalog = new Map();

/**
 * Returns `{ title, rating, difficulty, tags }` for one problem, from cache
 * when possible.
 *
 * Never throws: a problem CodeChef will not describe still syncs, just under
 * "Unknown". The alternative — failing the push — would cost the user a
 * solution over a missing tag.
 */
export async function describeCodeChefProblem(problemCode, contestCode = '') {
    const code = String(problemCode || '').trim();
    if (!code) return { title: '', rating: null, difficulty: 'Unknown', tags: [] };

    const cached = memoryCatalog.get(code);
    if (cached) return cached;

    const { [CACHE_KEY]: catalog = {} } = await chrome.storage.local.get(CACHE_KEY);
    const stored = catalog[code];
    if (stored && stored.fetchedAt && Date.now() - stored.fetchedAt < CACHE_TTL_MS) {
        const described = {
            title: stored.title || code,
            rating: stored.rating ?? null,
            difficulty: difficultyBand(stored.rating ?? null),
            tags: stored.tags || []
        };
        memoryCatalog.set(code, described);
        return described;
    }

    let described;
    try {
        const payload = await fetchProblemPayload(code, contestCode);
        const rating = parseDifficultyRating(payload.difficulty_rating);
        described = {
            title: payload.problem_name || code,
            rating,
            difficulty: difficultyBand(rating),
            tags: pickTags(payload)
        };

        catalog[code] = { title: described.title, rating, tags: described.tags, fetchedAt: Date.now() };
        await chrome.storage.local.set({ [CACHE_KEY]: catalog });
    } catch (error) {
        console.warn(`AlgoPush: could not read CodeChef metadata for ${code}; syncing without it.`, error);
        // A stale cached copy beats nothing at all — a network hiccup should
        // cost a sync its newest titles, not file a known problem as Unknown
        // in a second folder beside the one it already lives in.
        described = stored
            ? { title: stored.title || code, rating: stored.rating ?? null, difficulty: difficultyBand(stored.rating ?? null), tags: stored.tags || [] }
            : { title: code, rating: null, difficulty: 'Unknown', tags: [] };
    }

    memoryCatalog.set(code, described);
    return described;
}

/* ==================================================================== *
 * Recent-submissions parsing
 *
 * `/recent/user` answers with `{ max_page, content }`, where `content` is a
 * rendered HTML table rather than data. The content script parses it with
 * DOMParser (see content-scripts/codechef.js); this regex version exists for
 * the service worker's catch-up pass, which runs with no tab open and has no
 * DOMParser at all.
 *
 * Both read exactly the same four things out of a row, and the markup they
 * read is unusually stable because it is server-rendered from a template:
 *   <td title='PROBLEM_CODE'><a href='/CONTEST/problems/CODE'>
 *   <span title='accepted'>            — the verdict
 *   <td title='C++'>C++</td>           — the language
 *   <a href='/viewsolution/123'>       — the submission id
 * ==================================================================== */

// Every attribute is matched with an either-quote class. CodeChef renders
// this fragment with single quotes today, but the DOMParser version in
// content-scripts/codechef.js does not care which quote style it gets, and the
// two must not be able to disagree: a regex that silently matches nothing here
// is indistinguishable from "this account has no accepted submissions", which
// is exactly the input that used to poison the catch-up watermark.
const ROW_PATTERN = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const VERDICT_PATTERN = /<span\s+[^>]*title=["']([^"']*)["']/;
const PROBLEM_LINK_PATTERN = /href=["']\/(?:([A-Za-z0-9_-]+)\/)?problems\/([A-Za-z0-9_-]+)["']/;
const SUBMISSION_ID_PATTERN = /href=["']\/viewsolution\/(\d+)["']/;
const LANGUAGE_CELL_PATTERN = /<td\s+[^>]*title=["']([^"']*)["'][^>]*>\s*[^<]*<\/td>\s*<td[^>]*title=["']View["']/;

/**
 * Extracts the Accepted submissions from one `/recent/user` page.
 *
 * The verdict is compared for *equality* with "accepted" rather than by
 * substring: CodeChef's other verdict is "partially accepted", which contains
 * it, and pushing a 40/100 submission as a solved problem would be wrong.
 */
export function parseRecentSubmissionRows(html) {
    const rows = [];
    ROW_PATTERN.lastIndex = 0;

    let match;
    while ((match = ROW_PATTERN.exec(html)) !== null) {
        const row = match[1];

        const verdict = VERDICT_PATTERN.exec(row);
        if (!verdict || verdict[1].trim().toLowerCase() !== 'accepted') continue;

        const problem = PROBLEM_LINK_PATTERN.exec(row);
        const submissionId = SUBMISSION_ID_PATTERN.exec(row);
        // Both are required: a problem with no readable submission id cannot
        // have its source fetched, so queueing it would only fail later.
        if (!problem || !submissionId) continue;

        const language = LANGUAGE_CELL_PATTERN.exec(row);

        rows.push({
            id: Number(submissionId[1]),
            problemCode: problem[2],
            contestCode: problem[1] || '',
            language: language ? language[1].trim() : ''
        });
    }

    return rows;
}

export const CODECHEF_RECENT_URL = 'https://www.codechef.com/recent/user';
