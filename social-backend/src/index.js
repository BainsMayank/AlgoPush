// AlgoPush profiles, friends and duels.
//
// Everything here is optional to the extension: syncing to GitHub never
// touches this Worker. A profile exists only once someone creates one from
// the popup, and it holds just enough to show friends a streak, a list of
// solves and who won a duel — the same records the extension already keeps
// in syncedProblemsIndex, never any source code.
//
// Identity is the user's GitHub account. The extension already holds a GitHub
// token from connecting its repository, so signing in sends that token here
// once; this Worker asks GitHub whose it is and throws the token away. There
// is no password, and nothing here can write to anyone's repository.

import { computeRun, weekStart } from '../../shared/streak.js';

const GITHUB_USER_URL = 'https://api.github.com/user';

const DEFAULT_ALLOWED_ORIGINS = ['chrome-extension://oflhjpbehioebeaologailkkfbmleipl'];

const PLATFORMS = new Set(['LeetCode', 'Codeforces', 'AtCoder', 'CodeChef']);

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,22})[a-z0-9]$/i;

const MAX_BODY_BYTES = 512 * 1024;
const MAX_SUBMISSIONS_PER_REQUEST = 500;
const MAX_SUBMISSIONS_PER_USER = 20000;
// Accepted friendships and pending requests together.
const MAX_CONNECTIONS = 300;
const RECENT_LIMIT = 30;
const PAD_DAYS = 35;
// How far back the friends overview looks when counting a streak. A run
// longer than this reads as this many days on the overview; the expanded
// view counts the whole history.
const OVERVIEW_WINDOW_DAYS = 400;
const SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Solves stamped before this are not live syncs from any shipped version.
const EARLIEST_SOLVED_AT = Date.UTC(2024, 0, 1);

// Durations a duel may run for, in hours. A race is short and sharp; a sprint
// needs long enough for more than one sitting.
const DUEL_HOURS = { race: [1, 24, 72], sprint: [24, 72, 168] };
const MAX_OPEN_DUELS = 10;
// A challenge nobody answers lapses rather than sitting there forever.
const PENDING_DUEL_TTL_MS = 48 * HOUR_MS;
const RECENT_DUEL_DAYS = 30;
const NUDGE_COOLDOWN_MS = 12 * HOUR_MS;
const INBOX_LOOKBACK_MS = 7 * DAY_MS;
const INBOX_LIMIT = 20;
// The crew feed: friends' solves from today and the two days before it.
const FEED_DAYS = 2;
const FEED_LIMIT = 30;
// How many closed weeks a first league settle looks back over.
const CROWN_BACKFILL_WEEKS = 4;
// Page size when an install pulls its own shared solves back.
const OWN_SUBMISSIONS_PAGE = 1000;

const RATE_LIMITS = {
    // Each sign-in costs a call to GitHub; a real one needs one attempt.
    auth: { max: 10, windowSeconds: 60 },
    // Sending a request is the only way to learn whether a handle exists.
    invite: { max: 30, windowSeconds: 600 },
    duel: { max: 20, windowSeconds: 600 },
    nudge: { max: 30, windowSeconds: 3600 }
};

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/* ==================================================================== *
 * HTTP plumbing
 * ==================================================================== */

function allowedOrigins(env) {
    if (!env.ALLOWED_ORIGINS) return DEFAULT_ALLOWED_ORIGINS;
    return env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
}

// Same stance as the Codeforces exchange Worker: a request with no Origin is
// not a browser-enforced context, and Chrome does not reliably attach one to
// extension fetches, so it is served. Every route that reads or writes
// account data is behind a bearer session regardless.
function isOriginAllowed(origin, env) {
    if (!origin) return true;
    return allowedOrigins(env).includes(origin);
}

function corsHeaders(origin, env) {
    const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
    if (origin && isOriginAllowed(origin, env)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }
    return headers;
}

function json(data, status, origin, env) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...corsHeaders(origin, env)
        }
    });
}

async function readJson(request) {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
    if (!raw) return {};
    try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        return body;
    } catch {
        throw new HttpError(400, 'Invalid JSON body.');
    }
}

/* ==================================================================== *
 * Rate limiting — KV when bound, a per-isolate counter otherwise.
 * ==================================================================== */

const isolateHits = new Map();

function isolateRateLimited(key, max, windowSeconds, now) {
    const windowStart = now - windowSeconds * 1000;
    for (const [existing, hits] of isolateHits) {
        const live = hits.filter(at => at > now - 3600 * 1000);
        if (live.length) isolateHits.set(existing, live);
        else isolateHits.delete(existing);
    }
    const hits = (isolateHits.get(key) || []).filter(at => at > windowStart);
    hits.push(now);
    isolateHits.set(key, hits);
    return hits.length > max;
}

async function enforceRateLimit(env, bucket, subject) {
    const { max, windowSeconds } = RATE_LIMITS[bucket];
    const key = `rl:${bucket}:${subject}`;
    let limited;

    if (env.RATE_LIMIT_KV) {
        try {
            const current = Number(await env.RATE_LIMIT_KV.get(key)) || 0;
            limited = current >= max;
            if (!limited) {
                await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: Math.max(60, windowSeconds) });
            }
        } catch (e) {
            console.warn('Rate-limit store unavailable; falling back to the isolate counter.', e);
            limited = isolateRateLimited(key, max, windowSeconds, Date.now());
        }
    } else {
        limited = isolateRateLimited(key, max, windowSeconds, Date.now());
    }

    if (limited) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
}

/* ==================================================================== *
 * Identity
 * ==================================================================== */

function bytesToHex(bytes) {
    return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes) {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashToken(token) {
    return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

async function verifyGithubToken(githubToken) {
    if (typeof githubToken !== 'string' || githubToken.length < 10 || githubToken.length > 512) {
        throw new HttpError(400, 'githubToken is required.');
    }

    let response;
    try {
        response = await fetch(GITHUB_USER_URL, {
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'algopush-social'
            }
        });
    } catch (e) {
        throw new HttpError(502, `Could not reach GitHub: ${e.message}`);
    }

    if (response.status === 401 || response.status === 403) {
        throw new HttpError(401, 'GitHub did not accept the connection. Reconnect GitHub in AlgoPush and try again.');
    }
    if (!response.ok) {
        throw new HttpError(502, `GitHub answered HTTP ${response.status} when asked who you are.`);
    }

    const user = await response.json().catch(() => null);
    if (!user || typeof user.id !== 'number' || typeof user.login !== 'string') {
        throw new HttpError(502, 'GitHub returned an unexpected profile.');
    }
    return user;
}

function cleanAvatar(url) {
    return typeof url === 'string' && url.startsWith('https://avatars.githubusercontent.com/') ? url : null;
}

// Control characters and bidi overrides would let a name rearrange the text
// around it in a friend's list.
function cleanText(value, fallback, max) {
    const text = String(value ?? '')
        .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
        .trim()
        .slice(0, max);
    return text || fallback;
}

const cleanDisplayName = (value, fallback) => cleanText(value, fallback, 40);

function validateHandle(handle) {
    if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) {
        throw new HttpError(400,
            'Handles are 3–24 letters, numbers, hyphens or underscores, and start and end with a letter or number.',
            'bad_handle');
    }
    return handle;
}

async function createSession(env, userId) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = bytesToBase64Url(bytes);
    const now = Date.now();
    await env.DB.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?1, ?2, ?3, ?3)'
    ).bind(await hashToken(token), userId, now).run();
    return token;
}

async function authenticate(request, env) {
    const header = request.headers.get('Authorization') || '';
    const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header);
    if (!match) throw new HttpError(401, 'Sign in to AlgoPush first.', 'signed_out');

    const tokenHash = await hashToken(match[1]);
    const row = await env.DB.prepare(
        `SELECT u.*, s.last_used_at AS session_used_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?1`
    ).bind(tokenHash).first();

    if (!row) throw new HttpError(401, 'Your AlgoPush session ended. Sign in again.', 'signed_out');

    const now = Date.now();
    if (now - row.session_used_at > SESSION_TOUCH_INTERVAL_MS) {
        await env.DB.prepare('UPDATE sessions SET last_used_at = ?2 WHERE token_hash = ?1')
            .bind(tokenHash, now).run();
    }
    return { user: row, tokenHash };
}

function publicProfile(user) {
    return {
        handle: user.handle,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        githubLogin: user.github_login,
        sharing: Boolean(user.sharing)
    };
}

/* ==================================================================== *
 * Days and streaks
 *
 * Days are the extension's own "YYYY-MM-DD" strings. The viewer passes its
 * own today, so a streak reads the same here as it does on the viewer's own
 * board; anything implausible falls back to UTC.
 * ==================================================================== */

function toDayNumber(day) {
    return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

function fromDayNumber(n) {
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function resolveToday(url) {
    const utcToday = Math.floor(Date.now() / DAY_MS);
    const asked = url.searchParams.get('today');
    if (asked && /^\d{4}-\d{2}-\d{2}$/.test(asked)) {
        const n = toDayNumber(asked);
        if (Number.isFinite(n) && Math.abs(n - utcToday) <= 1) return n;
    }
    return utcToday;
}

// Runs, freezes and the longest run come from shared/streak.js, the same code
// the popup counts its own board with.
function summarise(dayRows, today) {
    const days = new Set();
    const thisWeek = weekStart(today);
    let week = 0;
    let league = 0;
    let lastWeek = 0;
    for (const row of dayRows) {
        const n = toDayNumber(row.day);
        days.add(n);
        if (n > today - 7 && n <= today) week += row.n;
        if (n >= thisWeek && n <= today) league += row.n;
        if (n >= thisWeek - 7 && n < thisWeek) lastWeek += row.n;
    }
    const run = computeRun(days, today);
    return {
        days,
        streak: run.run,
        activeToday: run.activeToday,
        freezes: run.freezes,
        longest: run.longest,
        frozen: run.frozen,
        week,
        league,
        lastWeek
    };
}

/* ==================================================================== *
 * Submissions
 * ==================================================================== */

function cleanUrl(value, prefixes) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || value.length > 500) return undefined;
    let url;
    try { url = new URL(value); } catch { return undefined; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (prefixes && !prefixes.some(prefix => value.startsWith(prefix))) return undefined;
    return value;
}

function cleanSubmission(raw, today) {
    if (!raw || typeof raw !== 'object') return null;
    const { key, platform, title, difficulty, link, solutionUrl, solvedOn, solvedAt } = raw;

    if (typeof key !== 'string' || !key || key.length > 200) return null;
    if (!PLATFORMS.has(platform)) return null;
    if (typeof title !== 'string' || !title.trim() || title.length > 300) return null;
    if (difficulty !== null && difficulty !== undefined && (typeof difficulty !== 'string' || difficulty.length > 40)) return null;
    if (typeof solvedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(solvedOn)) return null;
    const day = toDayNumber(solvedOn);
    if (!Number.isFinite(day) || day > today + 1) return null;

    const cleanLink = cleanUrl(link);
    const cleanSolution = cleanUrl(solutionUrl, ['https://github.com/']);
    if (cleanLink === undefined || cleanSolution === undefined) return null;

    return {
        key,
        platform,
        title: title.trim(),
        difficulty: difficulty || null,
        link: cleanLink,
        solutionUrl: cleanSolution,
        solvedOn,
        solvedAt: cleanSolvedAt(solvedAt)
    };
}

// A stamp that is not a plausible live-sync time is dropped rather than
// failing the row: the solve still counts for streaks, just not for duels.
// Stamps from the future are pulled back to now so a skewed clock cannot
// claim a win that has not happened yet.
function cleanSolvedAt(value) {
    if (!Number.isInteger(value) || value < EARLIEST_SOLVED_AT) return null;
    return Math.min(value, Date.now());
}

function submissionOut(row) {
    return {
        platform: row.platform,
        title: row.title,
        difficulty: row.difficulty,
        link: row.link,
        solutionUrl: row.solution_url,
        solvedOn: row.solved_on
    };
}

/* ==================================================================== *
 * Friendships
 * ==================================================================== */

async function findUserByHandle(env, handle) {
    if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) return null;
    return env.DB.prepare('SELECT * FROM users WHERE handle = ?1').bind(handle).first();
}

async function findLink(env, a, b) {
    return env.DB.prepare(
        `SELECT * FROM friendships
          WHERE (requester_id = ?1 AND addressee_id = ?2)
             OR (requester_id = ?2 AND addressee_id = ?1)`
    ).bind(a, b).first();
}

async function connectionCount(env, userId) {
    const row = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM friendships WHERE requester_id = ?1 OR addressee_id = ?1'
    ).bind(userId).first();
    return row ? row.n : 0;
}

/* ==================================================================== *
 * Handlers
 * ==================================================================== */

async function signIn({ request, env }) {
    await enforceRateLimit(env, 'auth', request.headers.get('CF-Connecting-IP') || 'unknown');
    const body = await readJson(request);
    const github = await verifyGithubToken(body.githubToken);

    const user = await env.DB.prepare('SELECT * FROM users WHERE github_id = ?1').bind(github.id).first();
    if (!user) {
        // Not an error the user did anything wrong to cause: the popup reads
        // this as "show the sign-up form", prefilled from GitHub.
        return [404, {
            error: 'No AlgoPush profile yet.',
            code: 'no_account',
            suggestion: {
                handle: HANDLE_PATTERN.test(github.login) ? github.login : '',
                displayName: cleanDisplayName(github.name, github.login),
                avatarUrl: cleanAvatar(github.avatar_url)
            }
        }];
    }

    // GitHub logins and avatars change; the numeric id does not.
    await env.DB.prepare('UPDATE users SET github_login = ?2, avatar_url = ?3 WHERE id = ?1')
        .bind(user.id, github.login, cleanAvatar(github.avatar_url)).run();
    user.github_login = github.login;
    user.avatar_url = cleanAvatar(github.avatar_url);

    return [200, { session: await createSession(env, user.id), profile: publicProfile(user) }];
}

async function signUp({ request, env }) {
    await enforceRateLimit(env, 'auth', request.headers.get('CF-Connecting-IP') || 'unknown');
    const body = await readJson(request);
    const handle = validateHandle(body.handle);
    const github = await verifyGithubToken(body.githubToken);

    const existing = await env.DB.prepare('SELECT * FROM users WHERE github_id = ?1').bind(github.id).first();
    if (existing) {
        throw new HttpError(409, `This GitHub account already has the profile @${existing.handle}. Sign in instead.`, 'has_account');
    }

    const taken = await env.DB.prepare('SELECT 1 FROM users WHERE handle = ?1').bind(handle).first();
    if (taken) throw new HttpError(409, `@${handle} is taken. Pick another handle.`, 'handle_taken');

    const user = {
        github_id: github.id,
        github_login: github.login,
        handle,
        display_name: cleanDisplayName(body.displayName, github.login),
        avatar_url: cleanAvatar(github.avatar_url),
        sharing: body.sharing === false ? 0 : 1,
        created_at: Date.now()
    };

    let result;
    try {
        result = await env.DB.prepare(
            `INSERT INTO users (github_id, github_login, handle, display_name, avatar_url, sharing, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        ).bind(user.github_id, user.github_login, user.handle, user.display_name,
            user.avatar_url, user.sharing, user.created_at).run();
    } catch (e) {
        // Two sign-ups racing for one handle, or one account, land here.
        if (/UNIQUE/i.test(String(e.message))) {
            throw new HttpError(409, `@${handle} is taken. Pick another handle.`, 'handle_taken');
        }
        throw e;
    }

    const id = result.meta.last_row_id;
    return [201, { session: await createSession(env, id), profile: publicProfile(user) }];
}

async function signOut({ env, auth }) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(auth.tokenHash).run();
    return [200, { ok: true }];
}

async function getMe({ auth }) {
    return [200, { profile: publicProfile(auth.user) }];
}

async function patchMe({ request, env, auth }) {
    const body = await readJson(request);
    const user = auth.user;

    if (body.displayName !== undefined) {
        user.display_name = cleanDisplayName(body.displayName, user.display_name);
    }
    if (body.sharing !== undefined) {
        if (typeof body.sharing !== 'boolean') throw new HttpError(400, 'sharing must be true or false.');
        user.sharing = body.sharing ? 1 : 0;
    }

    const statements = [
        env.DB.prepare('UPDATE users SET display_name = ?2, sharing = ?3 WHERE id = ?1')
            .bind(user.id, user.display_name, user.sharing)
    ];
    // Turning sharing off deletes what was shared rather than hiding it.
    if (!user.sharing) {
        statements.push(env.DB.prepare('DELETE FROM submissions WHERE user_id = ?1').bind(user.id));
    }
    await env.DB.batch(statements);

    return [200, { profile: publicProfile(user) }];
}

async function deleteMe({ env, auth }) {
    const id = auth.user.id;
    // Explicit rather than trusting ON DELETE CASCADE alone, so an account
    // deletion is complete whatever the database's foreign-key setting.
    await env.DB.batch([
        env.DB.prepare('DELETE FROM submissions WHERE user_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM friendships WHERE requester_id = ?1 OR addressee_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM duels WHERE challenger_id = ?1 OR opponent_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM nudges WHERE from_id = ?1 OR to_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM crowns WHERE user_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id)
    ]);
    return [200, { ok: true }];
}

async function putSubmissions({ request, env, url, auth }) {
    if (!auth.user.sharing) {
        throw new HttpError(409, 'Sharing is off for this profile, so nothing was stored.', 'sharing_off');
    }

    const body = await readJson(request);
    if (!Array.isArray(body.submissions)) throw new HttpError(400, 'submissions must be an array.');
    if (body.submissions.length > MAX_SUBMISSIONS_PER_REQUEST) {
        throw new HttpError(413, `Send at most ${MAX_SUBMISSIONS_PER_REQUEST} submissions per request.`);
    }

    const today = resolveToday(url);
    const clean = body.submissions.map(raw => cleanSubmission(raw, today)).filter(Boolean);
    const rejected = body.submissions.length - clean.length;
    if (clean.length === 0) return [200, { stored: 0, rejected }];

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE user_id = ?1')
        .bind(auth.user.id).first();
    if ((count ? count.n : 0) + clean.length > MAX_SUBMISSIONS_PER_USER) {
        // Upserts of problems already stored do not grow the table, so only
        // refuse when the new keys alone would cross the cap.
        const keys = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM submissions
              WHERE user_id = ?1 AND key IN (SELECT value FROM json_each(?2))`
        ).bind(auth.user.id, JSON.stringify(clean.map(s => s.key))).first();
        if (count.n + clean.length - keys.n > MAX_SUBMISSIONS_PER_USER) {
            throw new HttpError(413, 'This profile has reached the limit of shared solves.');
        }
    }

    // One statement however many rows: json_each unpacks the batch inside
    // SQLite, which keeps this clear of D1's bound-parameter limit.
    // `WHERE true` is required: without it SQLite parses ON CONFLICT as part
    // of the SELECT's join.
    await env.DB.prepare(
        `INSERT INTO submissions (user_id, key, platform, title, difficulty, link, solution_url, solved_on, solved_at)
         SELECT ?1,
                json_extract(value, '$.key'),
                json_extract(value, '$.platform'),
                json_extract(value, '$.title'),
                json_extract(value, '$.difficulty'),
                json_extract(value, '$.link'),
                json_extract(value, '$.solutionUrl'),
                json_extract(value, '$.solvedOn'),
                json_extract(value, '$.solvedAt')
           FROM json_each(?2) WHERE true
         ON CONFLICT(user_id, key) DO UPDATE SET
                platform = excluded.platform,
                title = excluded.title,
                difficulty = excluded.difficulty,
                link = excluded.link,
                solution_url = excluded.solution_url,
                solved_on = excluded.solved_on,
                -- A full re-upload from an install that lost the stamp must
                -- not erase the one already recorded.
                solved_at = COALESCE(excluded.solved_at, submissions.solved_at)`
    ).bind(auth.user.id, JSON.stringify(clean)).run();

    return [200, { stored: clean.length, rejected }];
}

// Your own shared solves, in key order, a page at a time — so an install
// that lost its local index (a reinstall, a new browser) can take back what
// it once shared. `after` is the last key of the previous page.
async function getOwnSubmissions({ env, url, auth }) {
    const after = url.searchParams.get('after') || '';
    if (after.length > 200) throw new HttpError(400, 'after is not a submission key.');

    const { results } = await env.DB.prepare(
        `SELECT key, platform, title, difficulty, link, solution_url, solved_on, solved_at
           FROM submissions WHERE user_id = ?1 AND key > ?2
          ORDER BY key LIMIT ?3`
    ).bind(auth.user.id, after, OWN_SUBMISSIONS_PAGE).all();

    return [200, {
        submissions: results.map(row => ({ key: row.key, ...submissionOut(row), solvedAt: row.solved_at })),
        next: results.length === OWN_SUBMISSIONS_PAGE ? results[results.length - 1].key : null
    }];
}

/* ==================================================================== *
 * Friends
 * ==================================================================== */

function person(row) {
    return { handle: row.handle, displayName: row.display_name, avatarUrl: row.avatar_url };
}

// Day rows for several people at once, grouped by user.
async function dayRowsFor(env, userIds, sinceDay) {
    const { results } = await env.DB.prepare(
        `SELECT user_id, solved_on AS day, COUNT(*) AS n
           FROM submissions
          WHERE user_id IN (SELECT value FROM json_each(?1)) AND solved_on >= ?2
          GROUP BY user_id, solved_on`
    ).bind(JSON.stringify(userIds), sinceDay).all();

    const byUser = new Map();
    for (const row of results) {
        if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
        byUser.get(row.user_id).push(row);
    }
    return byUser;
}

function intersect(a, b) {
    const both = new Set();
    for (const day of a) if (b.has(day)) both.add(day);
    return both;
}

// The friend streak: consecutive days on which you *both* solved something.
// It breaks if either of you misses a day — unless a freeze the two of you
// earned together covers it.
function together(myDays, theirDays, today) {
    const both = intersect(myDays, theirDays);
    const run = computeRun(both, today);
    return { streak: run.run, bothToday: run.activeToday, freezes: run.freezes, longest: run.longest };
}

function dayCountIn(dayRows, from, to) {
    let total = 0;
    for (const row of dayRows) {
        const n = toDayNumber(row.day);
        if (n >= from && n <= to) total += row.n;
    }
    return total;
}

// Hands out the crowns for every week that closed since this user last
// looked: a week is theirs when nobody among them and their sharing friends
// solved more (a tie at the top crowns everyone in it). Idempotent: the
// marker only moves forward and crowns are keyed by week.
async function settleCrowns(env, me, sharingFriendIds, daysByUser, today) {
    const thisWeek = weekStart(today);
    const marker = me.league_settled_week ? toDayNumber(me.league_settled_week) : NaN;
    const from = Number.isFinite(marker) ? Math.max(marker, thisWeek - 7 * CROWN_BACKFILL_WEEKS) : thisWeek - 7 * CROWN_BACKFILL_WEEKS;
    if (from >= thisWeek) return;

    const statements = [];
    if (me.sharing && sharingFriendIds.length) {
        const mine = daysByUser.get(me.id) || [];
        for (let week = from; week < thisWeek; week += 7) {
            const solves = dayCountIn(mine, week, week + 6);
            if (solves === 0) continue;
            const best = Math.max(...sharingFriendIds.map(id => dayCountIn(daysByUser.get(id) || [], week, week + 6)));
            if (solves >= best) {
                statements.push(env.DB.prepare(
                    'INSERT OR IGNORE INTO crowns (user_id, week_start, solves) VALUES (?1, ?2, ?3)'
                ).bind(me.id, fromDayNumber(week), solves));
            }
        }
    }
    statements.push(env.DB.prepare(
        'UPDATE users SET league_settled_week = ?2 WHERE id = ?1'
    ).bind(me.id, fromDayNumber(thisWeek)));
    await env.DB.batch(statements);
}

async function crownCounts(env, userIds) {
    if (userIds.length === 0) return new Map();
    const { results } = await env.DB.prepare(
        `SELECT user_id, COUNT(*) AS n FROM crowns
          WHERE user_id IN (SELECT value FROM json_each(?1)) GROUP BY user_id`
    ).bind(JSON.stringify(userIds)).all();
    return new Map(results.map(row => [row.user_id, row.n]));
}

// What friends solved lately, newest first, for the crew feed.
async function crewFeed(env, friendsById, today) {
    const ids = [...friendsById.keys()];
    if (ids.length === 0) return [];
    const { results } = await env.DB.prepare(
        `SELECT user_id, platform, title, difficulty, link, solution_url, solved_on, solved_at
           FROM submissions
          WHERE user_id IN (SELECT value FROM json_each(?1)) AND solved_on >= ?2 AND solved_on <= ?3
          ORDER BY solved_on DESC, COALESCE(solved_at, 0) DESC, rowid DESC
          LIMIT ?4`
    ).bind(JSON.stringify(ids), fromDayNumber(today - FEED_DAYS), fromDayNumber(today + 1), FEED_LIMIT).all();

    return results.map(row => ({
        ...person(friendsById.get(row.user_id)),
        ...submissionOut(row),
        solvedAt: row.solved_at
    }));
}

async function listFriends({ env, url, auth }) {
    const me = auth.user;
    const today = resolveToday(url);
    const thisWeek = weekStart(today);

    const { results: links } = await env.DB.prepare(
        `SELECT u.id, u.handle, u.display_name, u.avatar_url, u.github_login, u.sharing,
                f.status, f.requester_id, f.created_at AS linked_at
           FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.requester_id = ?1 THEN f.addressee_id ELSE f.requester_id END
          WHERE f.requester_id = ?1 OR f.addressee_id = ?1
          ORDER BY f.created_at DESC`
    ).bind(me.id).all();

    const friends = links.filter(l => l.status === 'accepted');
    const sharingFriends = friends.filter(f => f.sharing);
    const sharingIds = sharingFriends.map(f => f.id);
    if (me.sharing) sharingIds.push(me.id);

    const [daysByUser, { results: totals }] = await Promise.all([
        dayRowsFor(env, sharingIds, fromDayNumber(today - OVERVIEW_WINDOW_DAYS)),
        env.DB.prepare(
            `SELECT user_id, COUNT(*) AS total, MAX(solved_on) AS last
               FROM submissions
              WHERE user_id IN (SELECT value FROM json_each(?1))
              GROUP BY user_id`
        ).bind(JSON.stringify(sharingIds)).all()
    ]);
    const totalsByUser = new Map(totals.map(row => [row.user_id, row]));

    await settleCrowns(env, me, sharingFriends.map(f => f.id), daysByUser, today);
    const [crowns, feed] = await Promise.all([
        crownCounts(env, [me.id, ...friends.map(f => f.id)]),
        crewFeed(env, new Map(sharingFriends.map(f => [f.id, f])), today)
    ]);

    const statsFor = (user) => {
        if (!user.sharing) return { stats: null, days: new Set() };
        const summary = summarise(daysByUser.get(user.id) || [], today);
        const total = totalsByUser.get(user.id);
        return {
            days: summary.days,
            stats: {
                total: total ? total.total : 0,
                lastSolvedOn: total ? total.last : null,
                streak: summary.streak,
                activeToday: summary.activeToday,
                freezes: summary.freezes,
                week: summary.week,
                league: summary.league,
                lastWeek: summary.lastWeek
            }
        };
    };

    const mine = statsFor(me);

    const overview = friends.map(friend => {
        const { stats, days } = statsFor(friend);
        const pair = stats && mine.stats ? together(mine.days, days, today) : null;
        return {
            ...publicProfile(friend),
            crowns: crowns.get(friend.id) || 0,
            stats,
            together: pair && { streak: pair.streak, bothToday: pair.bothToday, freezes: pair.freezes }
        };
    });

    // Who is on a run today reads first; then the longest runs; then names.
    overview.sort((a, b) =>
        Number(Boolean(b.stats && b.stats.activeToday)) - Number(Boolean(a.stats && a.stats.activeToday))
        || ((b.stats && b.stats.streak) || 0) - ((a.stats && a.stats.streak) || 0)
        || a.displayName.localeCompare(b.displayName));

    return [200, {
        me: { ...publicProfile(me), crowns: crowns.get(me.id) || 0, stats: mine.stats },
        friends: overview,
        league: { weekStart: fromDayNumber(thisWeek), endsOn: fromDayNumber(thisWeek + 7) },
        feed,
        incoming: links.filter(l => l.status === 'pending' && l.requester_id !== me.id).map(person),
        outgoing: links.filter(l => l.status === 'pending' && l.requester_id === me.id).map(person)
    }];
}

async function lastNudge(env, fromId, toId) {
    const row = await env.DB.prepare(
        'SELECT MAX(created_at) AS at FROM nudges WHERE from_id = ?1 AND to_id = ?2'
    ).bind(fromId, toId).first();
    return row && row.at;
}

async function duelRecordAgainst(env, meId, otherId) {
    const row = await env.DB.prepare(
        `SELECT SUM(winner_id = ?1) AS won, SUM(winner_id = ?2) AS lost, SUM(winner_id IS NULL) AS drawn
           FROM duels
          WHERE status = 'finished'
            AND ((challenger_id = ?1 AND opponent_id = ?2) OR (challenger_id = ?2 AND opponent_id = ?1))`
    ).bind(meId, otherId).first();
    return { won: row.won || 0, lost: row.lost || 0, drawn: row.drawn || 0 };
}

async function getFriend({ env, url, auth, params }) {
    const me = auth.user;
    const friend = await findUserByHandle(env, params[0]);
    const link = friend && await findLink(env, me.id, friend.id);
    // Anyone who is not a friend gets the same answer as a handle that does
    // not exist, so this cannot be used to probe profiles.
    if (!link || link.status !== 'accepted') throw new HttpError(404, 'Not in your friends.', 'not_friends');

    await settleDuels(env, me.id);
    const nudgedAt = await lastNudge(env, me.id, friend.id);
    const social = {
        record: await duelRecordAgainst(env, me.id, friend.id),
        canNudgeAt: nudgedAt ? nudgedAt + NUDGE_COOLDOWN_MS : 0
    };

    const profile = publicProfile(friend);
    if (!friend.sharing) return [200, { profile, stats: null, together: null, ...social }];

    const today = resolveToday(url);
    const [{ results: dayRows }, { results: myDayRows }, { results: platformRows }, { results: recentRows }, crowns] = await Promise.all([
        env.DB.prepare(
            `SELECT solved_on AS day, COUNT(*) AS n FROM submissions
              WHERE user_id = ?1 GROUP BY solved_on ORDER BY solved_on DESC`
        ).bind(friend.id).all(),
        env.DB.prepare(
            'SELECT solved_on AS day, COUNT(*) AS n FROM submissions WHERE user_id = ?1 GROUP BY solved_on'
        ).bind(me.id).all(),
        env.DB.prepare(
            'SELECT platform, COUNT(*) AS n FROM submissions WHERE user_id = ?1 GROUP BY platform'
        ).bind(friend.id).all(),
        env.DB.prepare(
            `SELECT platform, title, difficulty, link, solution_url, solved_on FROM submissions
              WHERE user_id = ?1 ORDER BY solved_on DESC, rowid DESC LIMIT ?2`
        ).bind(friend.id, RECENT_LIMIT).all(),
        crownCounts(env, [friend.id])
    ]);

    const summary = summarise(dayRows, today);
    const padStart = today - PAD_DAYS;

    let pair = null;
    if (me.sharing) {
        const myDays = summarise(myDayRows, today);
        const both = together(myDays.days, summary.days, today);
        pair = {
            streak: both.streak,
            longest: both.longest,
            freezes: both.freezes,
            bothToday: both.bothToday,
            youToday: myDays.activeToday
        };
    }

    return [200, {
        profile: { ...profile, crowns: crowns.get(friend.id) || 0 },
        together: pair,
        ...social,
        stats: {
            total: platformRows.reduce((sum, row) => sum + row.n, 0),
            streak: summary.streak,
            longestStreak: summary.longest,
            activeToday: summary.activeToday,
            freezes: summary.freezes,
            week: summary.week,
            league: summary.league,
            platforms: Object.fromEntries(platformRows.map(row => [row.platform, row.n])),
            activity: dayRows.filter(row => toDayNumber(row.day) >= padStart).map(row => ({ day: row.day, count: row.n })),
            frozen: [...summary.frozen].filter(day => day >= padStart).sort((a, b) => a - b).map(fromDayNumber),
            recent: recentRows.map(submissionOut)
        }
    }];
}

async function requestFriend({ request, env, auth }) {
    await enforceRateLimit(env, 'invite', String(auth.user.id));
    const body = await readJson(request);
    const target = await findUserByHandle(env, body.handle);

    if (!target) throw new HttpError(404, `No AlgoPush profile has the handle @${body.handle}.`, 'no_such_handle');
    if (target.id === auth.user.id) throw new HttpError(400, 'That is your own handle.', 'self');

    const link = await findLink(env, auth.user.id, target.id);
    if (link && link.status === 'accepted') return [200, { status: 'friends', handle: target.handle }];
    if (link && link.requester_id === auth.user.id) return [200, { status: 'requested', handle: target.handle }];

    // They already asked you: asking back is saying yes.
    if (link) {
        await env.DB.prepare(
            `UPDATE friendships SET status = 'accepted', accepted_at = ?3 WHERE requester_id = ?1 AND addressee_id = ?2`
        ).bind(target.id, auth.user.id, Date.now()).run();
        return [200, { status: 'friends', handle: target.handle }];
    }

    if (await connectionCount(env, auth.user.id) >= MAX_CONNECTIONS) {
        throw new HttpError(409, 'You have reached the friend limit. Remove someone first.', 'limit');
    }

    await env.DB.prepare(
        `INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?1, ?2, 'pending', ?3)`
    ).bind(auth.user.id, target.id, Date.now()).run();
    return [201, { status: 'requested', handle: target.handle }];
}

async function acceptFriend({ env, auth, params }) {
    const from = await findUserByHandle(env, params[0]);
    const result = from && await env.DB.prepare(
        `UPDATE friendships SET status = 'accepted', accepted_at = ?3
          WHERE requester_id = ?1 AND addressee_id = ?2 AND status = 'pending'`
    ).bind(from.id, auth.user.id, Date.now()).run();

    if (!result || !result.meta.changes) throw new HttpError(404, 'That request is no longer open.', 'no_request');
    return [200, { status: 'friends', handle: from.handle }];
}

// Declining a request, withdrawing one and unfriending are all the same act:
// there is no longer any link between the two of you. Open duels between you
// go with it; finished ones stay in both records.
async function removeFriend({ env, auth, params }) {
    const other = await findUserByHandle(env, params[0]);
    if (other) {
        await env.DB.batch([
            env.DB.prepare(
                `DELETE FROM friendships
                  WHERE (requester_id = ?1 AND addressee_id = ?2)
                     OR (requester_id = ?2 AND addressee_id = ?1)`
            ).bind(auth.user.id, other.id),
            env.DB.prepare(
                `UPDATE duels SET status = 'cancelled', finished_at = ?3
                  WHERE status IN ('pending', 'active')
                    AND ((challenger_id = ?1 AND opponent_id = ?2) OR (challenger_id = ?2 AND opponent_id = ?1))`
            ).bind(auth.user.id, other.id, Date.now())
        ]);
    }
    return [200, { ok: true }];
}

async function requireFriend(env, me, handle) {
    const friend = await findUserByHandle(env, handle);
    const link = friend && await findLink(env, me.id, friend.id);
    if (!link || link.status !== 'accepted') throw new HttpError(404, 'Not in your friends.', 'not_friends');
    return friend;
}

async function nudgeFriend({ env, auth, params }) {
    await enforceRateLimit(env, 'nudge', String(auth.user.id));
    const friend = await requireFriend(env, auth.user, params[0]);

    const now = Date.now();
    const last = await lastNudge(env, auth.user.id, friend.id);
    if (last && now - last < NUDGE_COOLDOWN_MS) {
        throw new HttpError(429, `You already nudged @${friend.handle}. One nudge every 12 hours.`, 'nudge_cooldown');
    }

    await env.DB.prepare('INSERT INTO nudges (from_id, to_id, created_at) VALUES (?1, ?2, ?3)')
        .bind(auth.user.id, friend.id, now).run();
    return [201, { ok: true, canNudgeAt: now + NUDGE_COOLDOWN_MS }];
}

/* ==================================================================== *
 * Duels
 *
 * There is no clock running on the server: a duel is settled whenever
 * someone in it next reads anything. Every settle is an UPDATE guarded by
 * `status = 'active'`, so two readers settling at once agree.
 * ==================================================================== */

const PROBLEM_KEY_PATTERN = /^(LeetCode|Codeforces|AtCoder|CodeChef):[^\s]{1,190}$/;

async function expirePendingDuels(env, userId, now) {
    await env.DB.prepare(
        `UPDATE duels SET status = 'cancelled', finished_at = created_at + ?3
          WHERE status = 'pending' AND created_at < ?2
            AND (challenger_id = ?1 OR opponent_id = ?1)`
    ).bind(userId, now - PENDING_DUEL_TTL_MS, PENDING_DUEL_TTL_MS).run();
}

// Current scores. Only solves stamped as live syncs inside the window count,
// so importing history mid-duel changes nothing.
async function scoreDuel(env, duel, now) {
    const until = Math.min(now, duel.ends_at);

    if (duel.kind === 'race') {
        const first = await env.DB.prepare(
            `SELECT user_id, solved_at FROM submissions
              WHERE key = ?1 COLLATE NOCASE AND user_id IN (?2, ?3)
                AND solved_at >= ?4 AND solved_at <= ?5
              ORDER BY solved_at ASC LIMIT 1`
        ).bind(duel.problem_key, duel.challenger_id, duel.opponent_id, duel.started_at, until).first();
        return {
            challenger: first && first.user_id === duel.challenger_id ? 1 : 0,
            opponent: first && first.user_id === duel.opponent_id ? 1 : 0,
            winner: first ? first.user_id : null,
            decidedAt: first ? first.solved_at : null
        };
    }

    const { results } = await env.DB.prepare(
        `SELECT user_id, COUNT(*) AS n FROM submissions
          WHERE user_id IN (?1, ?2) AND solved_at >= ?3 AND solved_at <= ?4
          GROUP BY user_id`
    ).bind(duel.challenger_id, duel.opponent_id, duel.started_at, until).all();
    const counts = new Map(results.map(row => [row.user_id, row.n]));
    const challenger = counts.get(duel.challenger_id) || 0;
    const opponent = counts.get(duel.opponent_id) || 0;
    return {
        challenger,
        opponent,
        winner: challenger === opponent ? null : (challenger > opponent ? duel.challenger_id : duel.opponent_id),
        decidedAt: null
    };
}

async function settleDuel(env, duel, now) {
    if (duel.status !== 'active') return duel;

    const score = await scoreDuel(env, duel, now);
    const raceWon = duel.kind === 'race' && score.winner !== null;
    const live = { ...duel, challenger_score: score.challenger, opponent_score: score.opponent };
    if (!raceWon && now < duel.ends_at) return live;

    const settled = {
        ...live,
        status: 'finished',
        winner_id: score.winner,
        decided_at: score.decidedAt,
        finished_at: now
    };
    await env.DB.prepare(
        `UPDATE duels SET status = 'finished', winner_id = ?2, challenger_score = ?3, opponent_score = ?4,
                decided_at = ?5, finished_at = ?6
          WHERE id = ?1 AND status = 'active'`
    ).bind(duel.id, settled.winner_id, settled.challenger_score, settled.opponent_score,
        settled.decided_at, settled.finished_at).run();
    return settled;
}

async function settleDuels(env, userId, now = Date.now()) {
    await expirePendingDuels(env, userId, now);
    const { results } = await env.DB.prepare(
        `SELECT * FROM duels WHERE status = 'active' AND (challenger_id = ?1 OR opponent_id = ?1)`
    ).bind(userId).all();
    const settled = new Map();
    for (const duel of results) settled.set(duel.id, await settleDuel(env, duel, now));
    return settled;
}

const DUEL_WITH_PEOPLE = `
    SELECT d.*,
           c.handle AS c_handle, c.display_name AS c_display_name, c.avatar_url AS c_avatar_url,
           o.handle AS o_handle, o.display_name AS o_display_name, o.avatar_url AS o_avatar_url
      FROM duels d
      JOIN users c ON c.id = d.challenger_id
      JOIN users o ON o.id = d.opponent_id`;

// A duel as the viewer sees it: "you" and "them", never challenger/opponent
// ids, and a result from the viewer's side.
function duelOut(duel, viewerId) {
    const mine = duel.challenger_id === viewerId;
    const prefix = mine ? 'o_' : 'c_';
    const you = mine ? duel.challenger_score : duel.opponent_score;
    const them = mine ? duel.opponent_score : duel.challenger_score;

    let result = null;
    if (duel.status === 'finished') {
        result = duel.winner_id === null ? 'draw' : duel.winner_id === viewerId ? 'won' : 'lost';
    }

    return {
        id: duel.id,
        kind: duel.kind,
        status: duel.status,
        role: mine ? 'challenger' : 'opponent',
        opponent: {
            handle: duel[`${prefix}handle`],
            displayName: duel[`${prefix}display_name`],
            avatarUrl: duel[`${prefix}avatar_url`]
        },
        problem: duel.kind === 'race'
            ? { key: duel.problem_key, title: duel.problem_title, link: duel.problem_link }
            : null,
        hours: Math.round(duel.duration_ms / HOUR_MS),
        createdAt: duel.created_at,
        startedAt: duel.started_at,
        endsAt: duel.ends_at,
        expiresAt: duel.status === 'pending' ? duel.created_at + PENDING_DUEL_TTL_MS : null,
        finishedAt: duel.finished_at,
        decidedAt: duel.decided_at,
        you: you ?? 0,
        them: them ?? 0,
        result,
        forfeited: duel.forfeited_by ? (duel.forfeited_by === viewerId ? 'you' : 'them') : null
    };
}

async function loadDuel(env, id) {
    if (!/^\d{1,12}$/.test(String(id))) return null;
    return env.DB.prepare(`${DUEL_WITH_PEOPLE} WHERE d.id = ?1`).bind(Number(id)).first();
}

async function listDuels({ env, auth }) {
    const me = auth.user.id;
    const now = Date.now();
    const settled = await settleDuels(env, me, now);

    const { results } = await env.DB.prepare(
        `${DUEL_WITH_PEOPLE}
          WHERE (d.challenger_id = ?1 OR d.opponent_id = ?1)
            AND (d.status IN ('pending', 'active') OR (d.status = 'finished' AND d.finished_at >= ?2))
          ORDER BY COALESCE(d.finished_at, d.started_at, d.created_at) DESC
          LIMIT 60`
    ).bind(me, now - RECENT_DUEL_DAYS * DAY_MS).all();

    // Active rows carry the live scores computed by the settle pass.
    const duels = results.map(row => {
        const live = settled.get(row.id);
        return duelOut(live && live.status === row.status ? { ...row, ...live } : row, me);
    });

    const record = await env.DB.prepare(
        `SELECT SUM(winner_id = ?1) AS won,
                SUM(winner_id IS NOT NULL AND winner_id <> ?1) AS lost,
                SUM(winner_id IS NULL) AS drawn
           FROM duels WHERE status = 'finished' AND (challenger_id = ?1 OR opponent_id = ?1)`
    ).bind(me).first();

    return [200, {
        record: { won: record.won || 0, lost: record.lost || 0, drawn: record.drawn || 0 },
        duels
    }];
}

async function alreadySolved(env, userIds, key) {
    return env.DB.prepare(
        `SELECT user_id FROM submissions
          WHERE key = ?1 COLLATE NOCASE AND user_id IN (SELECT value FROM json_each(?2)) LIMIT 1`
    ).bind(key, JSON.stringify(userIds)).first();
}

async function createDuel({ request, env, auth }) {
    await enforceRateLimit(env, 'duel', String(auth.user.id));
    const me = auth.user;
    const body = await readJson(request);

    const kind = body.kind;
    if (kind !== 'race' && kind !== 'sprint') throw new HttpError(400, 'A duel is a race or a sprint.');
    if (!DUEL_HOURS[kind].includes(body.hours)) {
        throw new HttpError(400, `A ${kind} runs for ${DUEL_HOURS[kind].join(', ')} hours.`);
    }

    const friend = await requireFriend(env, me, body.handle);
    if (!me.sharing) {
        throw new HttpError(409, 'Turn on sharing in Settings first — a duel is scored from shared solves.', 'sharing_off');
    }
    if (!friend.sharing) {
        throw new HttpError(409, `@${friend.handle} is not sharing solves, so a duel could not be scored.`, 'friend_not_sharing');
    }

    let problem = { key: null, title: null, link: null };
    if (kind === 'race') {
        const raw = body.problem || {};
        const link = cleanUrl(raw.link);
        if (typeof raw.key !== 'string' || !PROBLEM_KEY_PATTERN.test(raw.key) || !link) {
            throw new HttpError(400, 'A race needs a problem link from LeetCode, Codeforces, AtCoder or CodeChef.', 'bad_problem');
        }
        problem = { key: raw.key, title: cleanText(raw.title, raw.key, 200), link };

        // Racing to a problem one of you has already solved is not a race.
        const solved = await alreadySolved(env, [me.id, friend.id], problem.key);
        if (solved) {
            const who = solved.user_id === me.id ? 'You have' : `@${friend.handle} has`;
            throw new HttpError(409, `${who} already solved that one. Pick a problem neither of you has.`, 'already_solved');
        }
    }

    const now = Date.now();
    await expirePendingDuels(env, me.id, now);
    const open = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM duels
          WHERE status IN ('pending', 'active') AND (challenger_id = ?1 OR opponent_id = ?1)`
    ).bind(me.id).first();
    if (open.n >= MAX_OPEN_DUELS) {
        throw new HttpError(409, `You have ${MAX_OPEN_DUELS} duels open. Finish or cancel one first.`, 'too_many_duels');
    }

    const result = await env.DB.prepare(
        `INSERT INTO duels (kind, challenger_id, opponent_id, status, problem_key, problem_title, problem_link,
                            duration_ms, created_at)
         VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8)`
    ).bind(kind, me.id, friend.id, problem.key, problem.title, problem.link, body.hours * HOUR_MS, now).run();

    return [201, { duel: duelOut(await loadDuel(env, result.meta.last_row_id), me.id) }];
}

async function duelForAction(env, me, id) {
    await settleDuels(env, me.id);
    const duel = await loadDuel(env, id);
    if (!duel || (duel.challenger_id !== me.id && duel.opponent_id !== me.id)) {
        throw new HttpError(404, 'That duel does not exist.', 'no_duel');
    }
    return duel;
}

async function acceptDuel({ env, auth, params }) {
    const me = auth.user;
    const duel = await duelForAction(env, me, params[0]);
    if (duel.opponent_id !== me.id || duel.status !== 'pending') {
        throw new HttpError(409, 'That challenge is no longer open.', 'not_pending');
    }
    if (!me.sharing) {
        throw new HttpError(409, 'Turn on sharing in Settings first — a duel is scored from shared solves.', 'sharing_off');
    }
    if (duel.kind === 'race' && await alreadySolved(env, [duel.challenger_id, duel.opponent_id], duel.problem_key)) {
        await env.DB.prepare(`UPDATE duels SET status = 'cancelled', finished_at = ?2 WHERE id = ?1`)
            .bind(duel.id, Date.now()).run();
        throw new HttpError(409, 'One of you solved that problem since the challenge was sent, so it was called off.', 'already_solved');
    }

    const now = Date.now();
    const result = await env.DB.prepare(
        `UPDATE duels SET status = 'active', started_at = ?2, ends_at = ?2 + duration_ms,
                challenger_score = 0, opponent_score = 0
          WHERE id = ?1 AND status = 'pending'`
    ).bind(duel.id, now).run();
    if (!result.meta.changes) throw new HttpError(409, 'That challenge is no longer open.', 'not_pending');

    return [200, { duel: duelOut(await loadDuel(env, duel.id), me.id) }];
}

async function declineDuel({ env, auth, params }) {
    const duel = await duelForAction(env, auth.user, params[0]);
    if (duel.opponent_id !== auth.user.id || duel.status !== 'pending') {
        throw new HttpError(409, 'That challenge is no longer open.', 'not_pending');
    }
    await env.DB.prepare(`UPDATE duels SET status = 'declined', finished_at = ?2 WHERE id = ?1 AND status = 'pending'`)
        .bind(duel.id, Date.now()).run();
    return [200, { ok: true }];
}

async function cancelDuel({ env, auth, params }) {
    const duel = await duelForAction(env, auth.user, params[0]);
    if (duel.challenger_id !== auth.user.id || duel.status !== 'pending') {
        throw new HttpError(409, 'Only a challenge still waiting for an answer can be withdrawn.', 'not_pending');
    }
    await env.DB.prepare(`UPDATE duels SET status = 'cancelled', finished_at = ?2 WHERE id = ?1 AND status = 'pending'`)
        .bind(duel.id, Date.now()).run();
    return [200, { ok: true }];
}

async function forfeitDuel({ env, auth, params }) {
    const me = auth.user;
    const duel = await duelForAction(env, me, params[0]);
    if (duel.status !== 'active') throw new HttpError(409, 'Only a duel in progress can be forfeited.', 'not_active');

    const winner = duel.challenger_id === me.id ? duel.opponent_id : duel.challenger_id;
    await env.DB.prepare(
        `UPDATE duels SET status = 'finished', winner_id = ?2, forfeited_by = ?3, finished_at = ?4
          WHERE id = ?1 AND status = 'active'`
    ).bind(duel.id, winner, me.id, Date.now()).run();
    return [200, { duel: duelOut(await loadDuel(env, duel.id), me.id) }];
}

/* ==================================================================== *
 * Inbox — what happened since the extension last looked, for notifications
 * and the toolbar badge.
 * ==================================================================== */

async function inbox({ env, url, auth }) {
    const me = auth.user.id;
    const now = Date.now();
    await settleDuels(env, me, now);

    const asked = Number(url.searchParams.get('since'));
    // First look, or a long absence: report the state, not a backlog.
    const since = Number.isFinite(asked) && asked > 0 ? Math.max(asked, now - INBOX_LOOKBACK_MS) : now;

    const [{ results: requests }, { results: accepted }, { results: nudges }, { results: duels }] = await Promise.all([
        env.DB.prepare(
            `SELECT u.handle, u.display_name, u.avatar_url, f.created_at AS at
               FROM friendships f JOIN users u ON u.id = f.requester_id
              WHERE f.addressee_id = ?1 AND f.status = 'pending' AND f.created_at > ?2`
        ).bind(me, since).all(),
        env.DB.prepare(
            `SELECT u.handle, u.display_name, u.avatar_url, f.accepted_at AS at
               FROM friendships f JOIN users u ON u.id = f.addressee_id
              WHERE f.requester_id = ?1 AND f.status = 'accepted' AND f.accepted_at > ?2`
        ).bind(me, since).all(),
        env.DB.prepare(
            `SELECT u.handle, u.display_name, u.avatar_url, n.created_at AS at
               FROM nudges n JOIN users u ON u.id = n.from_id
              WHERE n.to_id = ?1 AND n.created_at > ?2`
        ).bind(me, since).all(),
        env.DB.prepare(
            `${DUEL_WITH_PEOPLE}
              WHERE (d.challenger_id = ?1 OR d.opponent_id = ?1)
                AND ((d.opponent_id = ?1 AND d.status = 'pending' AND d.created_at > ?2)
                  OR (d.challenger_id = ?1 AND d.started_at > ?2)
                  OR (d.challenger_id = ?1 AND d.status = 'declined' AND d.finished_at > ?2)
                  OR (d.status = 'finished' AND d.finished_at > ?2 AND COALESCE(d.forfeited_by, 0) <> ?1))`
        ).bind(me, since).all()
    ]);

    const events = [
        ...requests.map(r => ({ type: 'friend_request', at: r.at, from: person(r) })),
        ...accepted.map(r => ({ type: 'friend_accepted', at: r.at, from: person(r) })),
        ...nudges.map(r => ({ type: 'nudge', at: r.at, from: person(r) }))
    ];
    for (const row of duels) {
        const duel = duelOut(row, me);
        let type;
        let at;
        if (row.status === 'finished' && row.finished_at > since) {
            type = 'duel_finished';
            at = row.finished_at;
        } else if (row.status === 'declined') {
            type = 'duel_declined';
            at = row.finished_at;
        } else if (row.status === 'pending') {
            type = 'duel_invite';
            at = row.created_at;
        } else if (row.challenger_id === me && row.started_at > since) {
            type = 'duel_started';
            at = row.started_at;
        } else {
            continue;
        }
        events.push({ type, at, from: duel.opponent, duel });
    }
    events.sort((a, b) => a.at - b.at);

    const waiting = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM friendships WHERE addressee_id = ?1 AND status = 'pending') AS requests,
                (SELECT COUNT(*) FROM duels WHERE opponent_id = ?1 AND status = 'pending') AS challenges`
    ).bind(me).first();

    return [200, {
        now,
        events: events.slice(-INBOX_LIMIT),
        waiting: { requests: waiting.requests, challenges: waiting.challenges }
    }];
}

const ROUTES = [
    ['POST', /^\/v1\/auth\/github$/, signIn, { public: true }],
    ['POST', /^\/v1\/auth\/signup$/, signUp, { public: true }],
    ['POST', /^\/v1\/auth\/signout$/, signOut],
    ['GET', /^\/v1\/me$/, getMe],
    ['PATCH', /^\/v1\/me$/, patchMe],
    ['DELETE', /^\/v1\/me$/, deleteMe],
    ['PUT', /^\/v1\/me\/submissions$/, putSubmissions],
    ['GET', /^\/v1\/me\/submissions$/, getOwnSubmissions],
    ['GET', /^\/v1\/inbox$/, inbox],
    ['GET', /^\/v1\/friends$/, listFriends],
    ['POST', /^\/v1\/friends$/, requestFriend],
    ['GET', /^\/v1\/friends\/([^/]+)$/, getFriend],
    ['POST', /^\/v1\/friends\/([^/]+)\/accept$/, acceptFriend],
    ['POST', /^\/v1\/friends\/([^/]+)\/nudge$/, nudgeFriend],
    ['DELETE', /^\/v1\/friends\/([^/]+)$/, removeFriend],
    ['GET', /^\/v1\/duels$/, listDuels],
    ['POST', /^\/v1\/duels$/, createDuel],
    ['POST', /^\/v1\/duels\/(\d+)\/accept$/, acceptDuel],
    ['POST', /^\/v1\/duels\/(\d+)\/decline$/, declineDuel],
    ['POST', /^\/v1\/duels\/(\d+)\/forfeit$/, forfeitDuel],
    ['DELETE', /^\/v1\/duels\/(\d+)$/, cancelDuel]
];

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin');

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders(origin, env) });
        }
        if (!isOriginAllowed(origin, env)) {
            return json({ error: 'Origin not allowed.' }, 403, origin, env);
        }
        if (!env.DB) {
            return json({ error: 'Server misconfigured: no DB binding.' }, 500, origin, env);
        }

        const url = new URL(request.url);
        let route = null;
        let params = [];
        for (const candidate of ROUTES) {
            const match = candidate[1].exec(url.pathname);
            if (match && candidate[0] === request.method) {
                route = candidate;
                params = match.slice(1);
                break;
            }
        }
        if (!route) return json({ error: 'Not found.' }, 404, origin, env);

        const [, , handler, options = {}] = route;
        try {
            try {
                params = params.map(decodeURIComponent);
            } catch {
                throw new HttpError(400, 'Malformed path.');
            }
            const auth = options.public ? null : await authenticate(request, env);
            const [status, data] = await handler({ request, env, url, auth, params });
            return json(data, status, origin, env);
        } catch (e) {
            if (e instanceof HttpError) {
                return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status, origin, env);
            }
            console.error('Unhandled error', e);
            return json({ error: 'Something went wrong on the AlgoPush server.' }, 500, origin, env);
        }
    }
};
