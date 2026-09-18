// AtCoder problem catalog — titles, contests, and difficulty estimates.
//
// AtCoder publishes no API of its own: not for submissions, not for problem
// metadata, and certainly not for difficulty. What every AtCoder tool uses
// instead is the community-run AtCoder Problems dataset (kenkoooo.com), which
// mirrors AtCoder's own data and adds the IRT-based difficulty estimates that
// AtCoder users actually think in ("this is a 1200", "that's a yellow"). This
// module wraps the two static resource files it publishes.
//
// It is deliberately *only* metadata. Submission source code never comes from
// here — that is read from atcoder.jp itself, through the user's own signed-in
// session, exactly as the Codeforces and LeetCode paths do.
//
// The two files are ~1.2 MB each and change at most a few times a week (when a
// contest ends), so they are fetched once and cached, reduced to the three
// fields AlgoPush needs. Both callers — the service worker enriching a live
// submission and the options page listing a historical import — go through the
// same cache, so a sync costs one download, not one per problem.

// The dataset's per-user submission list. Exported because both callers need
// it — the service worker's catch-up pass and the options page's historical
// import — and two copies of a third-party URL is one copy too many to keep in
// step when it moves.
export const AC_SUBMISSIONS_URL = 'https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions';

const PROBLEMS_URL = 'https://kenkoooo.com/atcoder/resources/problems.json';
const MODELS_URL = 'https://kenkoooo.com/atcoder/resources/problem-models.json';

const CACHE_KEY = 'acProblemCatalog';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * AtCoder difficulty is an *estimated rating*, and the ratings run from
 * roughly -1000 (a first "print Hello") to 4000+. Filing one folder per
 * rating value the way the Codeforces import does would scatter a few hundred
 * solutions across a few hundred folders, so problems are bucketed into the
 * eight colour bands AtCoder itself uses for user ratings — the vocabulary an
 * AtCoder user already has for "how hard was that".
 */
const DIFFICULTY_BANDS = [
    { max: 400, name: 'Gray' },
    { max: 800, name: 'Brown' },
    { max: 1200, name: 'Green' },
    { max: 1600, name: 'Cyan' },
    { max: 2000, name: 'Blue' },
    { max: 2400, name: 'Yellow' },
    { max: 2800, name: 'Orange' },
    { max: Infinity, name: 'Red' }
];

/**
 * AtCoder Problems clamps its own display of sub-400 estimates through this
 * correction rather than showing the raw (often deeply negative) model output,
 * and users read those corrected numbers on the site every day. Matching it
 * means a problem AlgoPush calls "Gray, 42" is the same 42 the site shows,
 * instead of a raw -1147 nobody recognises.
 */
export function correctedDifficulty(rawDifficulty) {
    if (rawDifficulty === null || rawDifficulty === undefined) return null;
    if (rawDifficulty >= 400) return Math.round(rawDifficulty);
    return Math.round(400 / Math.exp(1.0 - rawDifficulty / 400));
}

export function difficultyBand(rawDifficulty) {
    const corrected = correctedDifficulty(rawDifficulty);
    if (corrected === null) return 'Unknown';
    return DIFFICULTY_BANDS.find(band => corrected < band.max).name;
}

/**
 * Contest series, used as the topic grouping in the repo's root README.
 *
 * AtCoder tags nothing — there is no "dynamic programming" label to read, on
 * the site or in the dataset. The contest a problem came from is the one piece
 * of structure that genuinely exists, and it is also how AtCoder problems are
 * actually referred to ("ABC 300 D"), so it beats filing every last solution
 * under "Uncategorized".
 */
const CONTEST_SERIES = [
    [/^abc\d/, 'AtCoder Beginner Contest'],
    [/^arc\d/, 'AtCoder Regular Contest'],
    [/^agc\d/, 'AtCoder Grand Contest'],
    [/^ahc\d/, 'AtCoder Heuristic Contest'],
    [/^typical90$/, 'Typical 90 Problems'],
    [/^tessoku-book$/, 'Tessoku Book'],
    [/^math-and-algorithm$/, 'Math and Algorithm'],
    [/^(dp|tdpc|edpc)$/, 'DP Contests'],
    [/^past\d/, 'PAST (Algorithmic Skill Test)'],
    [/^(joi|jag|jsc)/, 'JOI / JAG / JSC'],
    [/^practice/, 'Practice Contests']
];

export function contestSeries(contestId) {
    const id = String(contestId || '').toLowerCase();
    const match = CONTEST_SERIES.find(([pattern]) => pattern.test(id));
    return match ? match[1] : 'Other Contests';
}

async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`AtCoder Problems returned HTTP ${response.status} for ${url}.`);
    }
    return response.json();
}

/**
 * Downloads and reduces both dataset files into
 * `{ [problemId]: { title, contestId, index, difficulty } }`.
 */
async function downloadCatalog() {
    // Difficulty is the optional half: a brand-new problem has no model yet,
    // and the whole import must not fail because of that.
    const [problems, models] = await Promise.all([
        fetchJson(PROBLEMS_URL),
        fetchJson(MODELS_URL).catch(error => {
            console.warn('AlgoPush: AtCoder difficulty estimates are unavailable; problems will be filed as Unknown.', error);
            return {};
        })
    ]);

    const catalog = {};
    for (const problem of problems) {
        if (!problem || !problem.id) continue;
        const model = models[problem.id];
        catalog[problem.id] = {
            title: problem.name || problem.title || problem.id,
            contestId: problem.contest_id || '',
            index: problem.problem_index || '',
            difficulty: model && typeof model.difficulty === 'number' ? model.difficulty : null
        };
    }
    return catalog;
}

/** In-memory cache, so repeated lookups inside one run don't re-read storage. */
let memoryCatalog = null;

/**
 * Returns the problem catalog, downloading it only when there is no fresh
 * copy in storage.
 *
 * A stale cached copy is preferred over a failure: a network hiccup should
 * cost a sync its newest problem titles, not the whole run.
 */
export async function getAtCoderCatalog({ forceRefresh = false } = {}) {
    if (memoryCatalog && !forceRefresh) return memoryCatalog;

    const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
    const isFresh = cached && cached.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

    if (isFresh && !forceRefresh) {
        memoryCatalog = cached.problems;
        return memoryCatalog;
    }

    try {
        const problems = await downloadCatalog();
        memoryCatalog = problems;
        await chrome.storage.local.set({ [CACHE_KEY]: { fetchedAt: Date.now(), problems } });
        return problems;
    } catch (error) {
        if (cached && cached.problems) {
            console.warn('AlgoPush: could not refresh the AtCoder problem catalog; using the cached copy.', error);
            memoryCatalog = cached.problems;
            return memoryCatalog;
        }
        throw error;
    }
}

/**
 * The canonical AlgoPush slug for an AtCoder problem.
 *
 * Both halves are needed: `abc300_a` identifies the problem, but the contest
 * is what makes the task URL resolvable, and the same problem can be served
 * under more than one contest id (a rated contest and its unrated mirror).
 */
export function atcoderSlug(contestId, problemId) {
    return `${contestId}/${problemId}`;
}

export function parseAtCoderSlug(slug) {
    const separator = String(slug || '').indexOf('/');
    if (separator === -1) return { contestId: '', problemId: slug || '' };
    return { contestId: slug.slice(0, separator), problemId: slug.slice(separator + 1) };
}

/**
 * Fills in everything AlgoPush knows about an AtCoder problem: display title,
 * difficulty band, and contest-series tag. Safe to call with an unknown
 * problem id — a problem the dataset has not caught up with yet still syncs,
 * just under "Unknown".
 */
export function describeProblem(catalog, contestId, problemId, fallbackTitle = '') {
    const entry = (catalog && catalog[problemId]) || null;
    const difficulty = entry ? difficultyBand(entry.difficulty) : 'Unknown';

    return {
        title: (entry && entry.title) || fallbackTitle || problemId,
        difficulty,
        rating: entry ? correctedDifficulty(entry.difficulty) : null,
        tags: [contestSeries(contestId || (entry && entry.contestId))]
    };
}
