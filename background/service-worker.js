import { pushFileToRepo, deleteFileFromRepo, resolveBranch } from '../shared/github.js';
import { getEffectiveGithubToken } from '../shared/github-auth.js';
import { getAtCoderCatalog, describeProblem, parseAtCoderSlug, AC_SUBMISSIONS_URL } from '../shared/atcoder-catalog.js';
import {
    describeCodeChefProblem, difficultyBand as codechefDifficultyBand,
    parseDifficultyRating, codechefProblemUrl,
    parseRecentSubmissionRows, CODECHEF_RECENT_URL
} from '../shared/codechef-catalog.js';

/**
 * Onboarding: open the options page automatically the first time the
 * extension is installed, so the user isn't left guessing how to configure it.
 */
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
    // An extension update clears scheduled alarms; re-register the per-platform
    // catch-up passes so they don't silently stop after an upgrade.
    ensureCatchUpAlarm();
    ensureAtCoderCatchUpAlarm();
    ensureCodeChefCatchUpAlarm();
});

/**
 * Derives a common file extension from the language string.
 *
 * Matched in order against the *whole* language string as the judges report
 * it, which is never just the language name: "GNU C++20 (64)" on Codeforces,
 * "C++ 20 (gcc 12.2)" on AtCoder, "Python3" on LeetCode. The order matters —
 * "JavaScript" contains "java" and "C++" contains "c" — so the more specific
 * patterns are listed first and the first hit wins.
 */
const LANGUAGE_EXTENSIONS = [
    [/c\+\+|cpp/, 'cpp'],
    // 'cs2' is CodeChef's name for C#; it is not a C-family name the plain
    // 'c' pattern at the bottom should be allowed to claim.
    [/c#|csharp|^cs\d/, 'cs'],
    [/objective-?c/, 'm'],
    [/typescript/, 'ts'],
    [/javascript|node\.?js|\bjs\b/, 'js'],
    [/java/, 'java'],
    // PyPy is a Python implementation, and on Codeforces it is reported
    // without the word "Python" at all ("PyPy 3-64") — very common there.
    // 'pyth 3' is CodeChef's name for Python 3.
    [/python|\bpyth\b|pyth\s*\d|pypy|pandas/, 'py'],
    [/mysql|postgre|oracle|\bsql\b/, 'sql'],
    [/kotlin/, 'kt'],
    [/\bgo\b|golang/, 'go'],
    [/rust/, 'rs'],
    [/ruby/, 'rb'],
    [/swift/, 'swift'],
    [/scala/, 'scala'],
    [/haskell/, 'hs'],
    [/f#/, 'fs'],
    [/ocaml/, 'ml'],
    [/pascal|delphi/, 'pas'],
    [/fortran/, 'f90'],
    [/\bada\b/, 'adb'],
    [/cobol/, 'cob'],
    [/erlang/, 'erl'],
    [/elixir/, 'ex'],
    [/\bnim\b/, 'nim'],
    [/crystal/, 'cr'],
    [/julia/, 'jl'],
    [/\blua\b/, 'lua'],
    [/\bperl\b/, 'pl'],
    [/\braku\b/, 'raku'],
    [/\bphp\b/, 'php'],
    [/\bdart\b/, 'dart'],
    [/\bzig\b/, 'zig'],
    [/\bvim\b/, 'vim'],
    [/\br\b|\(gnu r\b/, 'r'],
    [/common lisp|\bsbcl\b/, 'lisp'],
    [/scheme|racket/, 'rkt'],
    [/prolog/, 'pl'],
    [/\bsed\b/, 'sed'],
    [/\bawk\b/, 'awk'],
    [/bash|\bzsh\b|\bsh\b|shell/, 'sh'],
    [/brainfuck/, 'bf'],
    [/assembl|\bnasm\b/, 'asm'],
    [/^d\b|\bd\s*\(|\bdmd|\bldc\b/, 'd'],
    // Plain C last, so it cannot steal "C++", "C#" or "Crystal".
    [/^c\b|^c\d|\bgnu c|\bc\s*\(/, 'c']
];

function getExtension(lang) {
    const l = String(lang || '').toLowerCase().trim();
    const match = LANGUAGE_EXTENSIONS.find(([pattern]) => pattern.test(l));
    return match ? match[1] : 'txt';
}

/**
 * Resolves the file extension for a solution.
 *
 * A judge that states the extension itself always wins — CodeChef does, and
 * its short language names ("PYTH 3", "NODEJS", "CS2") are precisely the ones
 * the pattern table above cannot parse, because they are not the names of the
 * languages. Anything that arrives is still sanitized before it becomes part
 * of a path: it is a value from a remote server, and a filename is not the
 * place to find out it contained a slash.
 */
function resolveExtension(data) {
    const declared = String(data.fileExtension || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (declared && declared.length <= 10) return declared;
    return getExtension(data.language);
}

/**
 * Reduces a problem title to something safe to use as a folder name.
 */
function sanitizePathSegment(value) {
    return String(value || '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

/**
 * Constructs the canonical link to the problem.
 */
function getProblemLink(data) {
    if (data.platform === 'LeetCode') {
        return `https://leetcode.com/problems/${data.slug}/`;
    }

    if (data.platform === 'AtCoder') {
        // AtCoder slug: 'contestId/problemId'.
        const { contestId, problemId } = parseAtCoderSlug(data.slug);
        if (contestId && problemId) {
            return `https://atcoder.jp/contests/${contestId}/tasks/${problemId}`;
        }
        return 'https://atcoder.jp/';
    }

    if (data.platform === 'CodeChef') {
        // CodeChef slug: the problem code, which is unique site-wide.
        return codechefProblemUrl(data.slug, data.contestCode);
    }

    // Codeforces slug: 'contestId-index'
    const parts = data.slug.split('-');
    if (parts.length >= 2) {
        const contestId = parts[0];
        const index = parts.slice(1).join('-'); // Rejoin in case index had a hyphen
        if (parseInt(contestId) >= 100000) {
            return `https://codeforces.com/gym/${contestId}/problem/${index}`;
        }
        return `https://codeforces.com/contest/${contestId}/problem/${index}`;
    }
    return `https://codeforces.com/`;
}

/**
 * GitHub's own heading-to-anchor algorithm (lowercase, spaces to hyphens,
 * strip anything else) — used so headings stay linkable if a table of
 * contents is added later, and so identical tag names across platforms
 * (e.g. "Dynamic Programming" on both Codeforces and LeetCode) don't produce
 * duplicate/colliding anchors.
 */
/**
 * Makes a value safe to drop into a Markdown table cell.
 *
 * Problem titles come from four different judges and are not sanitized for
 * Markdown anywhere else — a title containing a pipe silently splits its row
 * into extra columns, and one containing a newline ends the table early. The
 * brackets matter too, because the title is also used as link text.
 */
function escapeTableCell(value) {
    return String(value == null ? '' : value)
        .replace(/\r?\n/g, ' ')
        .replace(/\|/g, '\\|')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .trim();
}

function githubAnchor(text) {
    return text.toLowerCase().trim().replace(/[^\w\- ]/g, '').replace(/\s+/g, '-');
}

/**
 * Builds the full root README content from the structured index of every
 * synced problem — grouped by platform, then by topic tag, mirroring how
 * problems are actually organized on Codeforces/LeetCode. Regenerating the
 * whole file (instead of parsing and appending to existing markdown) is more
 * robust: there's no fragile "does this table already exist" text matching,
 * and pushFileToRepo already skips the commit when the content is unchanged.
 */
function buildRootReadmeContent(problemsIndex) {
    const entries = Object.values(problemsIndex);
    if (entries.length === 0) {
        return '# Algorithm Solutions\n\nSynced automatically by AlgoPush as you solve problems.\n';
    }

    const byPlatform = {};
    for (const entry of entries) {
        (byPlatform[entry.platform] ||= []).push(entry);
    }
    const platforms = Object.keys(byPlatform).sort();

    let md = '# Algorithm Solutions\n\n';
    md += '> Auto-generated by AlgoPush — organized by platform, then by topic.\n\n';
    md += '## Stats\n\n| Platform | Problems |\n| :--- | :--- |\n';
    for (const platform of platforms) {
        md += `| ${escapeTableCell(platform)} | ${byPlatform[platform].length} |\n`;
    }
    md += `| **Total** | **${entries.length}** |\n\n---\n\n`;

    for (const platform of platforms) {
        md += `## ${platform}\n\n`;

        const byTag = {};
        for (const entry of byPlatform[platform]) {
            const tags = entry.tags && entry.tags.length ? entry.tags : ['Uncategorized'];
            for (const tag of tags) {
                (byTag[tag] ||= []).push(entry);
            }
        }

        const tagNames = Object.keys(byTag).sort();
        for (const tag of tagNames) {
            md += `- [${escapeTableCell(tag)}](#${githubAnchor(`${platform}: ${tag}`)}) (${byTag[tag].length})\n`;
        }
        md += '\n';

        for (const tag of tagNames) {
            md += `### ${platform}: ${tag}\n\n`;
            md += '| Problem | Difficulty | Solution | Date Solved |\n| :--- | :--- | :--- | :--- |\n';
            const rows = byTag[tag].slice().sort((a, b) => a.title.localeCompare(b.title));
            for (const entry of rows) {
                md += `| [${escapeTableCell(entry.title)}](${encodeURI(entry.link || '')}) | ${escapeTableCell(entry.difficulty)} | [Solution](${encodeURI(entry.folderUrl || '')}) | ${escapeTableCell(entry.date)} |\n`;
            }
            md += '\n';
        }
    }

    return md;
}

/* ==================================================================== *
 * Branch resolution
 *
 * resolveBranch() costs two GitHub API calls (repo, then ref), and the answer
 * cannot change during a run. Calling it per submission meant a 300-problem
 * import spent 600 requests re-asking a question it already knew the answer
 * to, against a 5,000/hour budget it also needs for the actual pushes.
 *
 * Cached in memory only, so it dies with the service worker — which is the
 * right lifetime: a worker restart is exactly when re-checking is worthwhile.
 * ==================================================================== */

const BRANCH_CACHE_TTL_MS = 10 * 60 * 1000;
let branchCache = null;

async function getBranch(token, owner, repo) {
    const key = `${owner}/${repo}`;
    if (branchCache && branchCache.key === key && Date.now() - branchCache.at < BRANCH_CACHE_TTL_MS) {
        return branchCache.branch;
    }
    const branch = await resolveBranch(token, owner, repo, '');
    branchCache = { key, branch, at: Date.now() };
    return branch;
}

/**
 * Regenerates and pushes the root README.md from the full local index of
 * synced problems.
 */
async function updateRootReadme(token, owner, repo, branch, problemsIndex) {
    await pushFileToRepo({
        token, owner, repo, branch,
        path: 'README.md',
        content: buildRootReadmeContent(problemsIndex),
        commitMessage: 'Docs: Update solution index'
    });
}

/* ==================================================================== *
 * AtCoder metadata enrichment
 *
 * AtCoder publishes no problem titles, no difficulty and no tags through any
 * API, and the pages a submission is read from carry only the title. The
 * AtCoder Problems dataset has all three (see shared/atcoder-catalog.js), and
 * enriching here — in one place, on the way to GitHub — means the live
 * poller, the catch-up queue and the historical import all file the same
 * problem in the same folder under the same difficulty, instead of each
 * having to look it up for itself and disagreeing when one of them fails.
 *
 * Non-fatal by design: a problem the dataset has not caught up with yet still
 * syncs, just under "Unknown".
 * ==================================================================== */

async function enrichAtCoderSubmission(data) {
    const { contestId, problemId } = data.problemId
        ? { contestId: data.contestId, problemId: data.problemId }
        : parseAtCoderSlug(data.slug);

    try {
        const catalog = await getAtCoderCatalog();
        const described = describeProblem(catalog, contestId, problemId, data.title);

        data.title = described.title || data.title;
        if (!data.difficulty || data.difficulty === 'Unknown') data.difficulty = described.difficulty;
        if (!Array.isArray(data.tags) || data.tags.length === 0) data.tags = described.tags;
    } catch (error) {
        console.warn('AlgoPush: could not read AtCoder problem metadata; syncing without it.', error);
        if (!Array.isArray(data.tags) || data.tags.length === 0) data.tags = ['Other Contests'];
    }
}

/* ==================================================================== *
 * CodeChef metadata enrichment
 *
 * CodeChef publishes titles, difficulty ratings and topic tags itself, and the
 * content script — which is same-origin and therefore always gets through —
 * attaches them to the payload. What is left for here is the one thing that
 * must not be decided in two places: turning a raw difficulty rating into the
 * folder name a solution is filed under. The live poller, the catch-up queue
 * and the historical import all hand over the same raw rating, so all three
 * file the same problem in the same folder.
 *
 * The lookup below is only a fallback, for when the content script's own
 * metadata request failed. It is non-fatal by design: a problem CodeChef will
 * not describe still syncs, just under "Unknown".
 * ==================================================================== */

async function enrichCodeChefSubmission(data) {
    const problemCode = data.problemCode || data.slug;
    const rating = parseDifficultyRating(data.difficultyRating);
    const hasTags = Array.isArray(data.tags) && data.tags.length > 0;
    // A title still equal to the problem code means the content script's
    // metadata lookup came back empty, not that the problem is called that.
    const hasTitle = data.title && data.title !== problemCode;

    if (rating !== null && hasTags && hasTitle) {
        data.difficulty = codechefDifficultyBand(rating);
        return;
    }

    const described = await describeCodeChefProblem(problemCode, data.contestCode);

    data.title = hasTitle ? data.title : (described.title || data.title || problemCode);
    data.difficulty = codechefDifficultyBand(rating !== null ? rating : described.rating);
    if (!hasTags) data.tags = described.tags;
}

// Queue to process syncing sequentially so we don't spam GitHub with concurrent
// edits to the same repo — submission pushes and deferred index flushes alike.
let syncQueue = Promise.resolve();

/**
 * The root README is regenerated wholesale from the local index, so pushing it
 * after every single submission is pure waste during a bulk historical import:
 * N GitHub round-trips and N near-identical "Update solution index" commits,
 * each one a chance to lose a stale-SHA race with the next. Bulk importers
 * therefore set `deferIndexUpdate` and the index push is coalesced into a
 * single commit at the end of the run.
 *
 * `readmeIndexDirty` in storage is the durable "the repo's index is behind the
 * local one" flag, so an import that is cancelled, crashes, or outlives its
 * service worker still gets its README written — by the alarm below, by the
 * next live submission, or at the next browser startup.
 */
const README_FLUSH_ALARM = 'algopush-readme-flush';
const README_FLUSH_DELAY_MINUTES = 2;

async function markReadmeIndexDirty() {
    await chrome.storage.local.set({ readmeIndexDirty: true });
    await chrome.alarms.create(README_FLUSH_ALARM, { delayInMinutes: README_FLUSH_DELAY_MINUTES });
}

/**
 * Pushes the root README once, if anything is waiting to be written.
 * Returns { skipped: true } when there was nothing to do.
 */
async function flushRootReadme({ force = false } = {}) {
    const { readmeIndexDirty, syncedProblemsIndex = {}, githubRepo } =
        await chrome.storage.local.get(['readmeIndexDirty', 'syncedProblemsIndex', 'githubRepo']);

    if (!force && !readmeIndexDirty) return { ok: true, skipped: true };

    const token = await getEffectiveGithubToken();
    const [owner, repo] = (githubRepo || '').split('/');
    if (!token || !owner || !repo) {
        throw new Error('GitHub is not connected, so the solution index could not be updated.');
    }

    const branch = await getBranch(token, owner, repo);
    await updateRootReadme(token, owner, repo, branch, syncedProblemsIndex);

    await chrome.storage.local.set({ readmeIndexDirty: false });
    await chrome.alarms.clear(README_FLUSH_ALARM);
    return { ok: true };
}

/**
 * Runs a flush through the same serial queue as submission pushes, so a
 * timer-driven index write can never race a submission's own README update
 * into a stale-SHA conflict.
 */
function enqueueReadmeFlush() {
    syncQueue = syncQueue.then(() => flushRootReadme()).catch(error => {
        console.warn('AlgoPush: deferred solution-index update failed; it stays queued for the next attempt.', error);
    });
    return syncQueue;
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === README_FLUSH_ALARM) enqueueReadmeFlush();
    if (alarm.name === CF_CATCHUP_ALARM) enqueueCodeforcesCatchUp();
    if (alarm.name === AC_CATCHUP_ALARM) enqueueAtCoderCatchUp();
    if (alarm.name === CC_CATCHUP_ALARM) enqueueCodeChefCatchUp();
});

// An import interrupted by a browser restart still owes the repo an index,
// and a submission made while the browser was closed still owes a push.
chrome.runtime.onStartup.addListener(() => {
    enqueueReadmeFlush();
    enqueueCodeforcesCatchUp();
    enqueueAtCoderCatchUp();
    enqueueCodeChefCatchUp();
});


/* ==================================================================== *
 * Codeforces catch-up
 *
 * Live Codeforces sync is poll-based and lives in a content script, so it
 * only runs while a codeforces.com tab is open and visible. Submit, close the
 * tab within the poll interval, and that Accepted submission was simply
 * missed — permanently, once it fell out of the ten most recent.
 *
 * This closes that gap from the service worker, which runs with no tab open:
 * user.status is a public, unauthenticated endpoint, so the *detection* can
 * happen here. The source code cannot — Codeforces only serves it to a
 * same-origin request from a real page — so anything found here is recorded
 * in `cfPendingSubmissions` and the content script drains that queue the next
 * time any Codeforces page loads.
 *
 * `cfWatermarkSubmissionId` separates the two jobs: submission ids increase
 * monotonically, so anything at or below the watermark predates the install
 * and belongs to the historical import, and anything above it happened while
 * AlgoPush was watching and is guaranteed to be pushed. The first run
 * establishes the watermark and queues nothing.
 * ==================================================================== */

const CF_CATCHUP_ALARM = 'algopush-cf-catchup';
const CF_CATCHUP_PERIOD_MINUTES = 15;
const CF_CATCHUP_FETCH_COUNT = 100;
const CF_PENDING_LIMIT = 100;

async function runCodeforcesCatchUp() {
    const {
        cfOauthProfile,
        enableCodeforces,
        cfProcessedSubmissions = [],
        cfPendingSubmissions = [],
        cfWatermarkSubmissionId = null,
        syncedProblemsIndex = {}
    } = await chrome.storage.local.get([
        'cfOauthProfile', 'enableCodeforces', 'cfProcessedSubmissions',
        'cfPendingSubmissions', 'cfWatermarkSubmissionId', 'syncedProblemsIndex'
    ]);

    if (enableCodeforces === false) return;

    const handle = cfOauthProfile && cfOauthProfile.handle;
    if (!handle) return; // Nothing to watch until the account is connected.

    const response = await fetch(
        `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=${CF_CATCHUP_FETCH_COUNT}`
    );
    if (!response.ok) {
        throw new Error(`Codeforces user.status returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    if (payload.status !== 'OK' || !Array.isArray(payload.result)) {
        throw new Error(payload.comment || 'Codeforces user.status returned no result.');
    }

    const accepted = payload.result.filter(sub => sub.verdict === 'OK' && sub.problem);
    const highestId = accepted.reduce((max, sub) => Math.max(max, sub.id), 0);

    // First run: record where "now" is and stop. Everything already solved is
    // the historical import's job, not a surprise backfill.
    //
    // A watermark is only established once something was actually observed. A
    // request that succeeds but yields nothing is ambiguous — a brand-new
    // account looks exactly like a listing this pass failed to parse — and
    // writing 0 resolves that ambiguity the catastrophic way: every later pass
    // then sees every submission as newer than the watermark and queues a
    // backfill nobody asked for. Leaving it null costs one alarm period.
    if (cfWatermarkSubmissionId === null) {
        if (highestId > 0) {
            await chrome.storage.local.set({ cfWatermarkSubmissionId: highestId });
        }
        return;
    }

    const processed = new Set(cfProcessedSubmissions);
    const pendingIds = new Set(cfPendingSubmissions.map(item => item.id));

    const additions = [];
    for (const sub of accepted) {
        if (sub.id <= cfWatermarkSubmissionId) continue;   // predates the install
        if (processed.has(sub.id) || pendingIds.has(sub.id)) continue;

        const slug = `${sub.problem.contestId}-${sub.problem.index}`;
        additions.push({
            id: sub.id,
            slug,
            title: sub.problem.name,
            difficulty: sub.problem.rating ? sub.problem.rating.toString() : 'Unknown',
            tags: sub.problem.tags || [],
            programmingLanguage: sub.programmingLanguage
        });
    }

    if (additions.length === 0) return;

    console.log(`AlgoPush: queued ${additions.length} Codeforces submission(s) the live poller missed.`);
    await chrome.storage.local.set({
        cfPendingSubmissions: [...cfPendingSubmissions, ...additions].slice(-CF_PENDING_LIMIT)
    });
}

function enqueueCodeforcesCatchUp() {
    return runCodeforcesCatchUp().catch(error => {
        // Codeforces being unreachable or rate-limiting is routine; the next
        // alarm tries again.
        console.warn('AlgoPush: Codeforces catch-up check failed; retrying on the next pass.', error);
    });
}

/**
 * Registers the periodic alarm exactly once.
 *
 * This module is re-evaluated every time the service worker wakes, and an
 * unconditional chrome.alarms.create() with the same name *replaces* the
 * existing alarm and restarts its delay — so on a browser that wakes the
 * worker every few minutes the catch-up would be pushed forward forever and
 * never actually run. Only create it when it isn't already scheduled.
 */
async function ensureCatchUpAlarm() {
    const existing = await chrome.alarms.get(CF_CATCHUP_ALARM);
    if (existing) return;
    await chrome.alarms.create(CF_CATCHUP_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: CF_CATCHUP_PERIOD_MINUTES
    });
}

ensureCatchUpAlarm();

/* ==================================================================== *
 * AtCoder catch-up
 *
 * AtCoder's live sync has a narrower window than the other two platforms:
 * AtCoder has no cross-contest "my submissions" page, so the content script
 * can only watch the contest whose page is currently open. Submit, navigate
 * away before the judge finishes, and that Accepted submission is missed.
 *
 * This closes the gap from the service worker, which runs with no tab open.
 * The AtCoder Problems dataset exposes a public per-user submission list, so
 * the *detection* can happen here. The source code cannot — AtCoder serves
 * that only to the signed-in session on a real page — so anything found here
 * is recorded in `acPendingSubmissions` and the content script drains that
 * queue the next time any AtCoder page loads.
 *
 * `acWatermarkSubmissionId` separates the two jobs exactly as the Codeforces
 * watermark does: submission ids increase monotonically, so anything at or
 * below it predates the install and belongs to the historical import. The
 * first run establishes the watermark and queues nothing.
 * ==================================================================== */

const AC_CATCHUP_ALARM = 'algopush-ac-catchup';
const AC_CATCHUP_PERIOD_MINUTES = 15;
const AC_PENDING_LIMIT = 100;

// The dataset's per-user endpoint answers with everything submitted at or
// after `from_second`, capped at 500 results per call. The catch-up pass only
// needs the recent tail — walking the user's whole history is the historical
// import's job — so it asks for a fixed lookback well longer than any gap a
// closed browser could plausibly leave.
const AC_CATCHUP_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

async function fetchAtCoderSubmissions(user, fromSecond) {
    const url = `${AC_SUBMISSIONS_URL}?user=${encodeURIComponent(user)}&from_second=${fromSecond}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`AtCoder Problems returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
        throw new Error('AtCoder Problems returned an unexpected submission list.');
    }
    return payload;
}

async function runAtCoderCatchUp() {
    const {
        acProfile,
        enableAtCoder,
        acProcessedSubmissions = [],
        acPendingSubmissions = [],
        acWatermarkSubmissionId = null
    } = await chrome.storage.local.get([
        'acProfile', 'enableAtCoder', 'acProcessedSubmissions',
        'acPendingSubmissions', 'acWatermarkSubmissionId'
    ]);

    if (enableAtCoder === false) return;

    const user = acProfile && acProfile.username;
    if (!user) return; // Nothing to watch until the account is connected.

    const fromSecond = Math.max(0, Math.floor(Date.now() / 1000) - AC_CATCHUP_LOOKBACK_SECONDS);
    const submissions = await fetchAtCoderSubmissions(user, fromSecond);

    const accepted = submissions.filter(sub => sub.result === 'AC' && sub.problem_id);
    const highestId = accepted.reduce((max, sub) => Math.max(max, sub.id), 0);

    // First run: record where "now" is and stop. Everything already solved is
    // the historical import's job, not a surprise backfill.
    //
    // A watermark is only established once something was actually observed. A
    // request that succeeds but yields nothing is ambiguous — a brand-new
    // account looks exactly like a listing this pass failed to parse — and
    // writing 0 resolves that ambiguity the catastrophic way: every later pass
    // then sees every submission as newer than the watermark and queues a
    // backfill nobody asked for. Leaving it null costs one alarm period.
    if (acWatermarkSubmissionId === null) {
        if (highestId > 0) {
            await chrome.storage.local.set({ acWatermarkSubmissionId: highestId });
        }
        return;
    }

    const processed = new Set(acProcessedSubmissions);
    const pendingIds = new Set(acPendingSubmissions.map(item => item.id));

    // Newest first, so when the same problem was solved more than once in the
    // window it is the most recent Accepted submission that gets queued.
    const additions = [];
    const seenProblems = new Set();
    for (const sub of accepted.slice().sort((a, b) => b.id - a.id)) {
        if (sub.id <= acWatermarkSubmissionId) continue;   // predates the install
        if (processed.has(sub.id) || pendingIds.has(sub.id)) continue;
        if (seenProblems.has(sub.problem_id)) continue;
        seenProblems.add(sub.problem_id);

        additions.push({
            id: sub.id,
            contestId: sub.contest_id,
            problemId: sub.problem_id,
            // A placeholder: the real title comes from the catalog in
            // enrichAtCoderSubmission() on the way to GitHub.
            title: sub.problem_id,
            language: sub.language
        });
    }

    if (additions.length === 0) return;

    console.log(`AlgoPush: queued ${additions.length} AtCoder submission(s) the live poller missed.`);
    await chrome.storage.local.set({
        acPendingSubmissions: [...acPendingSubmissions, ...additions].slice(-AC_PENDING_LIMIT)
    });
}

function enqueueAtCoderCatchUp() {
    return runAtCoderCatchUp().catch(error => {
        // The dataset being unreachable is routine; the next alarm retries.
        console.warn('AlgoPush: AtCoder catch-up check failed; retrying on the next pass.', error);
    });
}

/** Same once-only registration as the Codeforces alarm above, same reason. */
async function ensureAtCoderCatchUpAlarm() {
    const existing = await chrome.alarms.get(AC_CATCHUP_ALARM);
    if (existing) return;
    await chrome.alarms.create(AC_CATCHUP_ALARM, {
        delayInMinutes: 2,
        periodInMinutes: AC_CATCHUP_PERIOD_MINUTES
    });
}

ensureAtCoderCatchUpAlarm();

/* ==================================================================== *
 * CodeChef catch-up
 *
 * Live CodeChef sync is poll-based and lives in a content script, so it only
 * runs while a codechef.com tab is open and visible. Submit, close the tab
 * within the poll interval, and that Accepted submission was simply missed.
 *
 * This closes that gap from the service worker, which runs with no tab open:
 * `/recent/user` answers an unauthenticated request for any public handle, so
 * the *detection* can happen here. The source code cannot — CodeChef serves
 * that only to the signed-in session — so anything found here is recorded in
 * `ccPendingSubmissions` and the content script drains that queue the next
 * time any CodeChef page loads.
 *
 * `ccWatermarkSubmissionId` separates the two jobs exactly as the Codeforces
 * and AtCoder watermarks do: submission ids increase monotonically, so
 * anything at or below it predates the install and belongs to the historical
 * import. The first run establishes the watermark and queues nothing.
 *
 * One thing this pass cannot do is parse HTML: a service worker has no
 * DOMParser. The rows come back as rendered markup, so they are read with the
 * regex mirror in shared/codechef-catalog.js instead.
 * ==================================================================== */

const CC_CATCHUP_ALARM = 'algopush-cc-catchup';
const CC_CATCHUP_PERIOD_MINUTES = 15;
const CC_PENDING_LIMIT = 100;

// Only the first page is read. It holds the most recent submissions of every
// kind, which is more than enough to cover a gap left by a closed browser —
// walking the whole history is the historical import's job.
const CC_CATCHUP_PAGE = 0;

async function runCodeChefCatchUp() {
    const {
        ccProfile,
        enableCodeChef,
        ccProcessedSubmissions = [],
        ccPendingSubmissions = [],
        ccWatermarkSubmissionId = null
    } = await chrome.storage.local.get([
        'ccProfile', 'enableCodeChef', 'ccProcessedSubmissions',
        'ccPendingSubmissions', 'ccWatermarkSubmissionId'
    ]);

    if (enableCodeChef === false) return;

    const handle = ccProfile && ccProfile.username;
    if (!handle) return; // Nothing to watch until the account is connected.

    const response = await fetch(
        `${CODECHEF_RECENT_URL}?user_handle=${encodeURIComponent(handle)}&page=${CC_CATCHUP_PAGE}`,
        { headers: { 'X-Requested-With': 'XMLHttpRequest' } }
    );
    if (!response.ok) {
        throw new Error(`CodeChef returned HTTP ${response.status} for the recent-submissions list.`);
    }

    const payload = await response.json();
    if (!payload || typeof payload.content !== 'string') {
        throw new Error('CodeChef returned an unexpected recent-submissions list.');
    }

    const accepted = parseRecentSubmissionRows(payload.content);
    const highestId = accepted.reduce((max, row) => Math.max(max, row.id), 0);

    // First run: record where "now" is and stop. Everything already solved is
    // the historical import's job, not a surprise backfill.
    //
    // A watermark is only established once something was actually observed. A
    // request that succeeds but yields nothing is ambiguous — a brand-new
    // account looks exactly like a listing this pass failed to parse — and
    // writing 0 resolves that ambiguity the catastrophic way: every later pass
    // then sees every submission as newer than the watermark and queues a
    // backfill nobody asked for. Leaving it null costs one alarm period.
    if (ccWatermarkSubmissionId === null) {
        if (highestId > 0) {
            await chrome.storage.local.set({ ccWatermarkSubmissionId: highestId });
        }
        return;
    }

    const processed = new Set(ccProcessedSubmissions);
    const pendingIds = new Set(ccPendingSubmissions.map(item => item.id));

    // Newest first, so when the same problem was solved more than once in the
    // window it is the most recent Accepted submission that gets queued.
    const additions = [];
    const seenProblems = new Set();
    for (const row of accepted.slice().sort((a, b) => b.id - a.id)) {
        if (row.id <= ccWatermarkSubmissionId) continue;   // predates the install
        if (processed.has(row.id) || pendingIds.has(row.id)) continue;
        if (seenProblems.has(row.problemCode)) continue;
        seenProblems.add(row.problemCode);

        additions.push({
            id: row.id,
            problemCode: row.problemCode,
            contestCode: row.contestCode,
            language: row.language
        });
    }

    if (additions.length === 0) return;

    console.log(`AlgoPush: queued ${additions.length} CodeChef submission(s) the live poller missed.`);
    await chrome.storage.local.set({
        ccPendingSubmissions: [...ccPendingSubmissions, ...additions].slice(-CC_PENDING_LIMIT)
    });
}

function enqueueCodeChefCatchUp() {
    return runCodeChefCatchUp().catch(error => {
        // CodeChef being unreachable, or Cloudflare turning away a request
        // that did not come from a real tab, is routine; the next alarm tries
        // again, and the live poller covers the same ground from any open tab.
        console.warn('AlgoPush: CodeChef catch-up check failed; retrying on the next pass.', error);
    });
}

/** Same once-only registration as the alarms above, same reason. */
async function ensureCodeChefCatchUpAlarm() {
    const existing = await chrome.alarms.get(CC_CATCHUP_ALARM);
    if (existing) return;
    await chrome.alarms.create(CC_CATCHUP_ALARM, {
        delayInMinutes: 3,
        periodInMinutes: CC_CATCHUP_PERIOD_MINUTES
    });
}

ensureCodeChefCatchUpAlarm();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    // Explicit end-of-import flush: write the coalesced solution index now
    // rather than waiting for the safety-net alarm.
    if (request.type === 'FLUSH_README_INDEX') {
        syncQueue = syncQueue.then(async () => {
            try {
                const result = await flushRootReadme({ force: Boolean(request.force) });
                sendResponse(result);
            } catch (error) {
                sendResponse({ ok: false, error: error.message || String(error) });
            }
        });
        return true;
    }

    // The AtCoder content script can only see one contest's submissions, so it
    // cannot establish the shared "live sync starts here" watermark on its own
    // — this does it from the full submission history. See ensureWatermark()
    // in content-scripts/atcoder.js.
    if (request.type === 'AC_ENSURE_WATERMARK') {
        enqueueAtCoderCatchUp().then(() => sendResponse({ ok: true }));
        return true;
    }

    if (request.type === 'SUBMISSION_ACCEPTED') {
        
        // Normalized outside the try block so it's visible from `catch` too —
        // previously this was declared with `const` inside `try`, so any error
        // thrown while building the error notification below (`data.title`)
        // threw a fresh ReferenceError and hid the real failure reason.
        const data = request;

        // Chain promises to ensure sequential processing
        syncQueue = syncQueue.then(async () => {
            try {
                const { githubRepo, enableLeetCode, enableCodeforces, enableAtCoder, enableCodeChef } = await chrome.storage.local.get(['githubRepo', 'enableLeetCode', 'enableCodeforces', 'enableAtCoder', 'enableCodeChef']);
                const githubToken = await getEffectiveGithubToken();

                if (!githubToken || !githubRepo) {
                    console.error("AlgoPush: GitHub not connected or repo not configured in options.");
                    chrome.notifications.create({
                        type: 'basic',
                        iconUrl: chrome.runtime.getURL('images/icon128.png'),
                        title: 'AlgoPush Configuration Required',
                        message: 'Please connect GitHub and choose a repository in the AlgoPush extension options to sync your code.'
                    });
                    sendResponse({ ok: false, error: 'Not configured: missing token or repo.' });
                    return;
                }

                const [owner, repo] = githubRepo.split('/');
                if (!owner || !repo) {
                    console.error("AlgoPush: Invalid GitHub repo format. Expected 'owner/repo'.");
                    sendResponse({ ok: false, error: "Invalid repo format in settings. Expected 'owner/repo'." });
                    return;
                }
                
                // Do not assume every repository calls its default branch "main".
                // This also turns a bad branch into a clear error before any files
                // are uploaded.
                const branch = await getBranch(githubToken, owner, repo);

                // Enforce platform toggles (default to true if undefined)
                if (data.platform === 'LeetCode' && enableLeetCode === false) {
                    console.log("AlgoPush: LeetCode sync is disabled in options.");
                    sendResponse({ ok: false, error: 'LeetCode sync disabled in settings.' });
                    return;
                }
                if (data.platform === 'Codeforces' && enableCodeforces === false) {
                    console.log("AlgoPush: Codeforces sync is disabled in options.");
                    sendResponse({ ok: false, error: 'Codeforces sync disabled in settings.' });
                    return;
                }
                if (data.platform === 'AtCoder' && enableAtCoder === false) {
                    console.log("AlgoPush: AtCoder sync is disabled in options.");
                    sendResponse({ ok: false, error: 'AtCoder sync disabled in settings.' });
                    return;
                }
                if (data.platform === 'CodeChef' && enableCodeChef === false) {
                    console.log("AlgoPush: CodeChef sync is disabled in options.");
                    sendResponse({ ok: false, error: 'CodeChef sync disabled in settings.' });
                    return;
                }

                // Title, difficulty and the contest-series tag are not on the
                // page an AtCoder submission is read from — fill them in
                // before anything depends on them (index key, folder path,
                // problem README, root index).
                if (data.platform === 'AtCoder') {
                    await enrichAtCoderSubmission(data);
                }

                // Same reasoning for CodeChef: the difficulty band a solution
                // is filed under is derived here, from the raw rating, so
                // every path into the repo agrees on the folder.
                if (data.platform === 'CodeChef') {
                    await enrichCodeChefSubmission(data);
                }

                console.log(`AlgoPush: Processing accepted submission for ${data.title}`);

                // 1. Normalize payload & Build File Paths
                const indexKey = `${data.platform}:${data.slug}`;
                const { syncedProblemsIndex: existingIndex = {} } = await chrome.storage.local.get('syncedProblemsIndex');
                const priorEntry = existingIndex[indexKey] || null;

                // A live push whose metadata lookup failed arrives with
                // difficulty 'Unknown', which would file the problem under
                // 'Uncategorized' — a *second* folder for a problem the
                // historical import already placed under its real difficulty.
                // Reuse what is already known about this problem instead, so
                // one problem always means one folder.
                const difficulty =
                    data.difficulty && data.difficulty !== 'Unknown'
                        ? data.difficulty
                        : (priorEntry && priorEntry.difficulty) || 'Unknown';
                data.difficulty = difficulty;

                // Same reasoning for tags: don't let a failed lookup blank out
                // the topic grouping an earlier push established.
                let tags = Array.isArray(data.tags) ? data.tags : [];
                if (tags.length === 0 && priorEntry && Array.isArray(priorEntry.tags)) {
                    tags = priorEntry.tags;
                }

                const platformFolder = data.platform;
                const groupFolder = difficulty !== 'Unknown' ? difficulty : 'Uncategorized';
                // A title made entirely of characters the sanitizer strips
                // collapses to an empty folder name and yields a broken path
                // like "AtCoder/Gray//solution.cpp". That is not hypothetical:
                // about one AtCoder problem in seven is named in Japanese. Fall
                // back to the problem's own identifier, which is always ASCII.
                const problemNameSafe =
                    sanitizePathSegment(data.title) ||
                    sanitizePathSegment(String(data.slug || '').replace(/\//g, '-')) ||
                    `problem-${data.submissionId}`;
                const ext = resolveExtension(data);

                const folderPath = `${platformFolder}/${groupFolder}/${problemNameSafe}`;
                const solutionPath = `${folderPath}/solution.${ext}`;
                const readmePath = `${folderPath}/README.md`;

                const commitMessage = `Add ${data.platform} - ${data.title} (${data.difficulty})`;

                // 2. Push Solution Code
                await pushFileToRepo({
                    token: githubToken,
                    owner, repo, branch,
                    path: solutionPath,
                    content: data.code,
                    commitMessage
                });

                // 3. Push Problem README.md
                const problemLink = getProblemLink(data);
                const problemReadmeContent = `# ${escapeTableCell(data.title)}\n\n` +
                    `**Platform:** ${data.platform}\n` +
                    `**Difficulty:** ${data.difficulty}\n` +
                    `**Link:** [${escapeTableCell(data.title)}](${encodeURI(problemLink)})\n\n` +
                    `**Tags:** ${tags.map(escapeTableCell).join(', ')}\n\n` +
                    `## Summary\nAuto-generated sync of an Accepted submission.`;

                await pushFileToRepo({
                    token: githubToken,
                    owner, repo, branch,
                    path: readmePath,
                    content: problemReadmeContent,
                    commitMessage: `Docs: Add README for ${data.title}`
                });

                // 4. Drop a solution file the language change just superseded.
                // Re-solving a problem in another language yields a different
                // extension, so the new file lands *beside* the old one rather
                // than replacing it; without this the folder ends up holding
                // one file per language ever used. Non-fatal by design — the
                // current solution is already committed at this point.
                if (priorEntry && priorEntry.solutionPath && priorEntry.solutionPath !== solutionPath) {
                    try {
                        await deleteFileFromRepo({
                            token: githubToken,
                            owner, repo, branch,
                            path: priorEntry.solutionPath,
                            commitMessage: `Chore: Replace ${data.title} solution with the ${data.language} version`
                        });
                    } catch (error) {
                        console.warn(`AlgoPush: could not remove the superseded solution file ${priorEntry.solutionPath}:`, error);
                    }
                }

                // 5. Update the root README.md index. This is optional; a
                // concurrent edit must not turn an already-committed source
                // file and problem README into a reported sync failure.
                let indexWarning = null;
                try {
                    const { syncedProblemsIndex = {} } = await chrome.storage.local.get('syncedProblemsIndex');
                    syncedProblemsIndex[indexKey] = {
                        title: data.title,
                        platform: data.platform,
                        difficulty,
                        tags,
                        link: problemLink,
                        folderUrl: `https://github.com/${owner}/${repo}/tree/HEAD/${folderPath}`,
                        // Remembered so a later re-solve in another language
                        // knows which file it is replacing (see step 4).
                        solutionPath,
                        date: new Date().toISOString().split('T')[0]
                    };
                    await chrome.storage.local.set({ syncedProblemsIndex });

                    if (data.deferIndexUpdate) {
                        // Bulk import in progress — coalesce into one commit at
                        // the end of the run (see flushRootReadme above).
                        await markReadmeIndexDirty();
                    } else {
                        await updateRootReadme(githubToken, owner, repo, branch, syncedProblemsIndex);
                        // A live submission rewrites the whole index anyway, so
                        // it also settles whatever an interrupted import left behind.
                        await chrome.storage.local.set({ readmeIndexDirty: false });
                        await chrome.alarms.clear(README_FLUSH_ALARM);
                    }
                } catch (error) {
                    indexWarning = error.message || String(error);
                    console.warn(`AlgoPush: Solution saved, but the root README index was not updated for ${data.title}:`, error);
                }

                // 6. Save to sync history
                const { syncHistory = [] } = await chrome.storage.local.get('syncHistory');
                syncHistory.unshift({
                    title: data.title,
                    platform: data.platform,
                    date: new Date().toISOString()
                });
                // Keep only last 50
                await chrome.storage.local.set({ syncHistory: syncHistory.slice(0, 50) });

                console.log(`AlgoPush: Successfully synced ${data.title}!`);
                sendResponse({ ok: true, warning: indexWarning });

            } catch (error) {
                console.error("AlgoPush: Sync workflow failed", error);
                await chrome.storage.local.set({
                    lastError: {
                        title: data.title || 'submission',
                        message: error.message || String(error),
                        date: new Date().toISOString()
                    }
                });
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: chrome.runtime.getURL('images/icon128.png'),
                    title: 'AlgoPush Error',
                    message: `Failed to sync ${data.title}: ${error.message}`
                });
                sendResponse({ ok: false, error: error.message });
            }
        }).catch(err => {
            try { sendResponse({ ok: false, error: err.message || String(err) }); } catch (_) {}
        });

        // Keep the message channel open until sendResponse() is called above,
        // once this item's turn in the queue has actually completed.
        return true;
    }
});
