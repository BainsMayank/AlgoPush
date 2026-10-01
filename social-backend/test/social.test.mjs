// Runs the Worker against a real SQLite database (node:sqlite) wearing a thin
// D1-shaped adapter, and a mocked GitHub. Needs no secrets and no network.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { dayNumber, dayString, weekStart } from '../../shared/streak.js';

const ORIGIN = 'chrome-extension://oflhjpbehioebeaologailkkfbmleipl';

function d1(db) {
    const wrap = (sql, args = []) => ({
        bind: (...next) => wrap(sql, next),
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args), success: true }),
        run: async () => {
            const r = db.prepare(sql).run(...args);
            return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        }
    });
    return {
        prepare: sql => wrap(sql),
        batch: async statements => {
            db.exec('BEGIN');
            try {
                const out = [];
                for (const s of statements) out.push(await s.run());
                db.exec('COMMIT');
                return out;
            } catch (e) {
                db.exec('ROLLBACK');
                throw e;
            }
        }
    };
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
for (const migration of ['0001_init.sql', '0002_duels.sql', '0003_league.sql']) {
    db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
}
const env = { DB: d1(db) };

const GITHUB_USERS = {
    'gho_alice_token_000': { id: 1, login: 'alice', name: 'Alice A', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
    'gho_bob_token_00000': { id: 2, login: 'bob', name: 'Bob', avatar_url: 'https://avatars.githubusercontent.com/u/2' },
    'gho_carol_token_000': { id: 3, login: 'carol', name: null, avatar_url: 'https://evil.test/a.png' },
    'gho_dave_token_0000': { id: 4, login: 'dave', name: 'Dave', avatar_url: null },
    'gho_erin_token_0000': { id: 5, login: 'erin', name: 'Erin', avatar_url: null },
    'gho_finn_token_0000': { id: 6, login: 'finn', name: 'Finn', avatar_url: null },
    'gho_gail_token_0000': { id: 7, login: 'gail', name: 'Gail', avatar_url: null },
    'gho_hank_token_0000': { id: 8, login: 'hank', name: 'Hank', avatar_url: null },
    'gho_ivy_token_00000': { id: 9, login: 'ivy', name: 'Ivy', avatar_url: null }
};

globalThis.fetch = async (url, init) => {
    if (url !== 'https://api.github.com/user') throw new Error(`unexpected fetch ${url}`);
    const token = (init.headers.Authorization || '').replace('Bearer ', '');
    const user = GITHUB_USERS[token];
    return user
        ? new Response(JSON.stringify(user), { status: 200 })
        : new Response('{"message":"Bad credentials"}', { status: 401 });
};

let ipSeq = 0;
async function call(method, path, { body, session, origin = ORIGIN, ip } = {}) {
    const headers = { 'CF-Connecting-IP': ip || `10.0.0.${++ipSeq}` };
    if (origin) headers.Origin = origin;
    if (session) headers.Authorization = `Bearer ${session}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await worker.fetch(new Request(`https://social.test${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }), env);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
}

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
    if (!ok) failures += 1;
}

const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const today = day(0);

/* ── sign-up and sign-in ───────────────────────────────────────────── */

let r = await call('POST', '/v1/auth/github', { body: { githubToken: 'gho_alice_token_000' } });
check('sign-in with no profile asks for sign-up', r.status === 404 && r.data.code === 'no_account'
    && r.data.suggestion.handle === 'alice' && r.data.suggestion.displayName === 'Alice A', JSON.stringify(r.data));

r = await call('POST', '/v1/auth/github', { body: { githubToken: 'gho_nobody_token_00' } });
check('a token GitHub rejects is a 401', r.status === 401, JSON.stringify(r.data));

r = await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_alice_token_000', handle: 'a!', displayName: 'x' } });
check('bad handle rejected', r.status === 400 && r.data.code === 'bad_handle', JSON.stringify(r.data));

r = await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_alice_token_000', handle: 'alice', displayName: '  Alice\u202E  ' } });
const alice = r.data.session;
check('sign-up creates a profile and a session', r.status === 201 && typeof alice === 'string'
    && r.data.profile.handle === 'alice' && r.data.profile.displayName === 'Alice', JSON.stringify(r.data));

r = await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_alice_token_000', handle: 'alice2' } });
check('one profile per GitHub account', r.status === 409 && r.data.code === 'has_account', JSON.stringify(r.data));

r = await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_bob_token_00000', handle: 'ALICE' } });
check('handles are unique ignoring case', r.status === 409 && r.data.code === 'handle_taken', JSON.stringify(r.data));

r = await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_bob_token_00000', handle: 'bob_b' } });
const bob = r.data.session;
r = await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_carol_token_000', handle: 'carol' } });
const carol = r.data.session;
check('display name falls back to the GitHub login; foreign avatar hosts are dropped',
    r.data.profile.displayName === 'carol' && r.data.profile.avatarUrl === null, JSON.stringify(r.data));

r = await call('POST', '/v1/auth/github', { body: { githubToken: 'gho_alice_token_000' } });
const alice2 = r.data.session;
check('existing profile signs in', r.status === 200 && alice2 && alice2 !== alice, JSON.stringify(r.data));

/* ── sessions ──────────────────────────────────────────────────────── */

r = await call('GET', '/v1/me');
check('no session is a 401', r.status === 401 && r.data.code === 'signed_out');
r = await call('GET', '/v1/me', { session: 'A'.repeat(43) });
check('unknown session is a 401', r.status === 401);
r = await call('GET', '/v1/me', { session: alice });
check('session reads its profile', r.status === 200 && r.data.profile.handle === 'alice');
const stored = db.prepare('SELECT token_hash FROM sessions').all().map(row => row.token_hash);
check('sessions are stored hashed', !stored.includes(alice) && stored.every(h => /^[0-9a-f]{64}$/.test(h)));

r = await call('POST', '/v1/auth/signout', { session: alice2 });
r = await call('GET', '/v1/me', { session: alice2 });
check('sign-out ends only that session', r.status === 401
    && (await call('GET', '/v1/me', { session: alice })).status === 200);

/* ── friend requests ───────────────────────────────────────────────── */

r = await call('POST', '/v1/friends', { session: alice, body: { handle: 'nobody' } });
check('request to an unknown handle is a 404', r.status === 404 && r.data.code === 'no_such_handle');
r = await call('POST', '/v1/friends', { session: alice, body: { handle: 'Alice' } });
check('cannot befriend yourself', r.status === 400 && r.data.code === 'self');

r = await call('POST', '/v1/friends', { session: alice, body: { handle: 'BOB_B' } });
check('request sent (handle matched ignoring case)', r.status === 201 && r.data.status === 'requested' && r.data.handle === 'bob_b', JSON.stringify(r.data));
r = await call('POST', '/v1/friends', { session: alice, body: { handle: 'bob_b' } });
check('re-sending is idempotent', r.status === 200 && r.data.status === 'requested');

r = await call('GET', '/v1/friends', { session: bob });
check('addressee sees it incoming', r.data.incoming.length === 1 && r.data.incoming[0].handle === 'alice' && r.data.friends.length === 0);
r = await call('GET', '/v1/friends', { session: alice });
check('requester sees it outgoing', r.data.outgoing.length === 1 && r.data.outgoing[0].handle === 'bob_b');

r = await call('GET', '/v1/friends/bob_b', { session: alice });
check('pending is not yet a friend', r.status === 404 && r.data.code === 'not_friends');
r = await call('POST', '/v1/friends/bob_b/accept', { session: alice });
check('requester cannot accept their own request', r.status === 404);

r = await call('POST', '/v1/friends/alice/accept', { session: bob });
check('addressee accepts', r.status === 200 && r.data.status === 'friends');

r = await call('POST', '/v1/friends', { session: carol, body: { handle: 'alice' } });
r = await call('POST', '/v1/friends', { session: alice, body: { handle: 'carol' } });
check('asking someone who already asked you accepts', r.status === 200 && r.data.status === 'friends');

/* ── shared solves ─────────────────────────────────────────────────── */

const sub = (key, solvedOn, extra = {}) => ({
    key: `LeetCode:${key}`, platform: 'LeetCode', title: key, difficulty: 'Easy',
    link: `https://leetcode.com/problems/${key}/`, solutionUrl: `https://github.com/bob/algos/tree/HEAD/${key}`,
    solvedOn, ...extra
});

r = await call('PUT', `/v1/me/submissions?today=${today}`, { session: bob, body: { submissions: [
    sub('two-sum', day(0)), sub('three-sum', day(0)), sub('valid-parens', day(-1)), sub('lru', day(-2)),
    sub('old-a', day(-10)), sub('old-b', day(-11)), sub('old-c', day(-12)), sub('old-d', day(-13)),
    sub('xss', day(0), { link: 'javascript:alert(1)' }),
    sub('bad-platform', day(0), { platform: 'HackerRank' }),
    sub('future', day(5)),
    sub('bad-solution', day(0), { solutionUrl: 'https://evil.test/x' })
] } });
check('valid solves stored, the rest rejected', r.status === 200 && r.data.stored === 8 && r.data.rejected === 4, JSON.stringify(r.data));

r = await call('PUT', `/v1/me/submissions?today=${today}`, { session: bob, body: { submissions: [
    sub('two-sum', day(0), { title: 'Two Sum' })
] } });
const total = db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;
check('re-uploading is an upsert', r.data.stored === 1 && total === 8, `total=${total}`);

r = await call('GET', `/v1/friends?today=${today}`, { session: alice });
const bobRow = r.data.friends.find(f => f.handle === 'bob_b');
check('overview carries streak, week and total', bobRow && bobRow.stats.streak === 3 && bobRow.stats.activeToday === true
    && bobRow.stats.week === 4 && bobRow.stats.total === 8 && bobRow.stats.lastSolvedOn === today, JSON.stringify(bobRow));
check('friends on a run today sort first', r.data.friends[0].handle === 'bob_b', r.data.friends.map(f => f.handle).join(','));

r = await call('GET', `/v1/friends/bob_b?today=${today}`, { session: alice });
check('detail carries longest run, platforms and recent solves', r.status === 200
    && r.data.stats.streak === 3 && r.data.stats.longestStreak === 4
    && r.data.stats.platforms.LeetCode === 8 && r.data.stats.recent.length === 8
    && r.data.stats.recent[0].solvedOn === today && r.data.stats.activity.length === 7, JSON.stringify(r.data.stats));

r = await call('GET', `/v1/friends/bob_b?today=${day(1)}`, { session: alice });
check('a streak survives the day that has not finished', r.data.stats.streak === 3 && r.data.stats.activeToday === false);
const dave = (await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_dave_token_0000', handle: 'dave' } })).data.session;
await call('POST', '/v1/friends', { session: dave, body: { handle: 'alice' } });
await call('POST', '/v1/friends/dave/accept', { session: alice });
await call('PUT', `/v1/me/submissions?today=${today}`, { session: dave, body: { submissions: [sub('d1', day(-2)), sub('d2', day(-3))] } });
r = await call('GET', `/v1/friends/dave?today=${today}`, { session: alice });
check('a missed full day breaks it', r.data.stats.streak === 0 && r.data.stats.longestStreak === 2, JSON.stringify(r.data.stats));
await call('DELETE', '/v1/me', { session: dave });
r = await call('GET', `/v1/friends/bob_b?today=${day(30)}`, { session: alice });
check('an implausible "today" falls back to UTC', r.data.stats.streak === 3);

r = await call('GET', '/v1/friends/bob_b', { session: carol });
check('a friend of a friend sees nothing', r.status === 404);

/* ── sharing off ───────────────────────────────────────────────────── */

r = await call('PATCH', '/v1/me', { session: bob, body: { sharing: false, displayName: 'Robert' } });
check('turning sharing off updates the profile', r.status === 200 && r.data.profile.sharing === false && r.data.profile.displayName === 'Robert');
check('…and deletes what was shared', db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n === 0);
r = await call('PUT', '/v1/me/submissions', { session: bob, body: { submissions: [sub('two-sum', day(0))] } });
check('uploads are refused while sharing is off', r.status === 409 && r.data.code === 'sharing_off');
r = await call('GET', '/v1/friends/bob_b', { session: alice });
check('friends still see the profile, without stats', r.status === 200 && r.data.stats === null && r.data.profile.displayName === 'Robert');

/* ── removing ──────────────────────────────────────────────────────── */

r = await call('DELETE', '/v1/friends/alice', { session: bob });
r = await call('GET', '/v1/friends/bob_b', { session: alice });
check('unfriending works from either side', r.status === 404);

r = await call('DELETE', '/v1/me', { session: carol });
check('account deletion', r.status === 200
    && (await call('GET', '/v1/me', { session: carol })).status === 401
    && db.prepare('SELECT COUNT(*) AS n FROM users WHERE handle = ?').get('carol').n === 0
    && db.prepare('SELECT COUNT(*) AS n FROM friendships').get().n === 0);
r = await call('POST', '/v1/auth/github', { body: { githubToken: 'gho_carol_token_000' } });
check('a deleted account can sign up again', r.status === 404 && r.data.code === 'no_account');

/* ── transport ─────────────────────────────────────────────────────── */

r = await call('GET', '/v1/me', { session: alice, origin: 'https://evil.test' });
check('foreign origin blocked', r.status === 403);
r = await call('GET', '/v1/me', { session: alice, origin: null });
check('no-origin request served', r.status === 200);
r = await call('GET', '/v1/friends/%E0%A4%A', { session: alice });
check('malformed path is a 400, not a crash', r.status === 400);

const pre = await worker.fetch(new Request('https://social.test/v1/me', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
check('preflight allows Authorization from the extension',
    pre.headers.get('Access-Control-Allow-Origin') === ORIGIN
    && /Authorization/.test(pre.headers.get('Access-Control-Allow-Headers')) && pre.headers.get('Vary') === 'Origin');

let limited = null;
for (let i = 0; i < 14; i += 1) {
    const res = await call('POST', '/v1/auth/github', { body: { githubToken: 'gho_dave_token_0000' }, ip: '5.5.5.5' });
    if (res.status === 429) { limited = i + 1; break; }
}
check('sign-in rate limit trips on the 11th attempt', limited === 11, `tripped at ${limited}`);

r = await call('PUT', '/v1/me/submissions', { session: alice, body: { submissions: Array.from({ length: 501 }, (_, i) => sub(`p${i}`, today)) } });
check('oversized batches refused', r.status === 413);

/* ── friend streaks, duels, nudges, inbox ──────────────────────────── */

// Duels are settled by the clock, so from here on the clock is ours.
let clock = Date.now();
Date.now = () => clock;
const HOUR = 3600 * 1000;
const tick = (ms) => { clock += ms; };

const erin = (await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_erin_token_0000', handle: 'erin' } })).data.session;
const finn = (await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_finn_token_0000', handle: 'finn' } })).data.session;
const gail = (await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_gail_token_0000', handle: 'gail' } })).data.session;

r = await call('GET', '/v1/inbox', { session: erin });
const erinSince = r.data.now;
check('first inbox look reports no backlog', r.status === 200 && r.data.events.length === 0);

await call('POST', '/v1/friends', { session: erin, body: { handle: 'finn' } });
r = await call('GET', `/v1/inbox?since=${erinSince - 1000}`, { session: finn });
check('friend request reaches the inbox', r.data.events.some(e => e.type === 'friend_request' && e.from.handle === 'erin')
    && r.data.waiting.requests === 1, JSON.stringify(r.data));
tick(1000);
await call('POST', '/v1/friends/erin/accept', { session: finn });
r = await call('GET', `/v1/inbox?since=${erinSince}`, { session: erin });
check('requester hears it was accepted', r.data.events.some(e => e.type === 'friend_accepted' && e.from.handle === 'finn'), JSON.stringify(r.data));

const t0 = day(0);
const stamp = (key, offset, at) => sub(key, day(offset), at === undefined ? {} : { solvedAt: at });
await call('PUT', `/v1/me/submissions?today=${t0}`, { session: erin, body: { submissions: [
    stamp('e0', 0), stamp('e1', -1), stamp('e2', -2), stamp('e3', -3), stamp('already-done', -5)
] } });
await call('PUT', `/v1/me/submissions?today=${t0}`, { session: finn, body: { submissions: [
    stamp('f0', 0), stamp('f1', -1), stamp('f3', -3)
] } });

r = await call('GET', `/v1/friends?today=${t0}`, { session: erin });
const finnRow = r.data.friends.find(f => f.handle === 'finn');
check('together streak counts days you both solved', finnRow.together.streak === 2 && finnRow.together.bothToday === true, JSON.stringify(finnRow));
check('list includes your own stats for the leaderboard', r.data.me.handle === 'erin' && r.data.me.stats.streak === 4 && r.data.me.stats.week === 5, JSON.stringify(r.data.me));
r = await call('GET', `/v1/friends/finn?today=${t0}`, { session: erin });
check('detail carries together streak and longest', r.data.together.streak === 2 && r.data.together.longest === 2
    && r.data.record.won === 0 && r.data.canNudgeAt === 0, JSON.stringify(r.data.together));

/* solvedAt */
await call('PUT', '/v1/me/submissions', { session: gail, body: { submissions: [
    stamp('future', 0, clock + 10 * HOUR), stamp('ancient', 0, 12345), stamp('fine', 0, clock - 1000)
] } });
const stamps = Object.fromEntries(db.prepare("SELECT key, solved_at FROM submissions WHERE user_id = (SELECT id FROM users WHERE handle = 'gail')").all().map(r => [r.key, r.solved_at]));
check('future stamps are pulled back to now; implausible ones dropped',
    stamps['LeetCode:future'] === clock && stamps['LeetCode:ancient'] === null && stamps['LeetCode:fine'] === clock - 1000, JSON.stringify(stamps));
await call('PUT', '/v1/me/submissions', { session: gail, body: { submissions: [stamp('fine', 0)] } });
check('a re-upload without a stamp keeps the recorded one',
    db.prepare("SELECT solved_at FROM submissions WHERE key = 'LeetCode:fine'").get().solved_at === clock - 1000);

/* duel validation */
r = await call('POST', '/v1/duels', { session: erin, body: { handle: 'gail', kind: 'sprint', hours: 24 } });
check('duels need a friend', r.status === 404);
r = await call('POST', '/v1/duels', { session: erin, body: { handle: 'finn', kind: 'sprint', hours: 5 } });
check('odd durations refused', r.status === 400);
r = await call('POST', '/v1/duels', { session: erin, body: { handle: 'finn', kind: 'race', hours: 1, problem: { key: 'LeetCode:x', link: 'javascript:alert(1)' } } });
check('race needs a real problem link', r.status === 400 && r.data.code === 'bad_problem');
r = await call('POST', '/v1/duels', { session: erin, body: { handle: 'finn', kind: 'race', hours: 1,
    problem: { key: 'LeetCode:already-done', title: 'Done', link: 'https://leetcode.com/problems/already-done/' } } });
check('race on a problem one of you solved is refused', r.status === 409 && r.data.code === 'already_solved', JSON.stringify(r.data));

/* sprint */
r = await call('POST', '/v1/duels', { session: erin, body: { handle: 'finn', kind: 'sprint', hours: 24 } });
const sprintId = r.data.duel && r.data.duel.id;
check('sprint challenge sent', r.status === 201 && r.data.duel.status === 'pending' && r.data.duel.role === 'challenger', JSON.stringify(r.data));
r = await call('GET', `/v1/inbox?since=${clock - 1}`, { session: finn });
check('challenge reaches the opponent', r.data.events.some(e => e.type === 'duel_invite' && e.duel.id === sprintId) && r.data.waiting.challenges === 1, JSON.stringify(r.data));
r = await call('POST', `/v1/duels/${sprintId}/accept`, { session: erin });
check('challenger cannot accept their own challenge', r.status === 409);
tick(1000);
r = await call('POST', `/v1/duels/${sprintId}/accept`, { session: finn });
check('opponent accepts; the clock starts', r.status === 200 && r.data.duel.status === 'active' && r.data.duel.endsAt === clock + 24 * HOUR);

tick(HOUR);
await call('PUT', '/v1/me/submissions', { session: erin, body: { submissions: [
    stamp('s1', 0, clock), stamp('s2', 0, clock + 1), stamp('import-no-stamp', 0)
] } });
await call('PUT', '/v1/me/submissions', { session: finn, body: { submissions: [
    stamp('s3', 0, clock), stamp('before-start', 0, clock - 5 * HOUR)
] } });
r = await call('GET', '/v1/duels', { session: finn });
let sprint = r.data.duels.find(d => d.id === sprintId);
check('live sprint score counts only stamped solves inside the window', sprint.status === 'active' && sprint.you === 1 && sprint.them === 2, JSON.stringify(sprint));

tick(24 * HOUR);
r = await call('GET', '/v1/duels', { session: finn });
sprint = r.data.duels.find(d => d.id === sprintId);
check('sprint settles when time is up', sprint.status === 'finished' && sprint.result === 'lost' && r.data.record.lost === 1, JSON.stringify(sprint));
r = await call('GET', `/v1/inbox?since=${clock - 1000}`, { session: erin });
check('winner hears the result', r.data.events.some(e => e.type === 'duel_finished' && e.duel.result === 'won'), JSON.stringify(r.data.events));

/* race */
const race = { key: 'LeetCode:lru-cache', title: 'LRU Cache', link: 'https://leetcode.com/problems/lru-cache/' };
r = await call('POST', '/v1/duels', { session: finn, body: { handle: 'erin', kind: 'race', hours: 1, problem: race } });
const raceId = r.data.duel.id;
await call('POST', `/v1/duels/${raceId}/accept`, { session: erin });
tick(20 * 60 * 1000);
await call('PUT', '/v1/me/submissions', { session: finn, body: { submissions: [{ ...stamp('x', 0, clock), key: 'LeetCode:LRU-Cache' }] } });
tick(1000);
await call('PUT', '/v1/me/submissions', { session: erin, body: { submissions: [{ ...stamp('x', 0, clock), key: 'LeetCode:lru-cache' }] } });
r = await call('GET', '/v1/duels', { session: erin });
const raceOut = r.data.duels.find(d => d.id === raceId);
check('race goes to the first stamped Accepted, before time is up', raceOut.status === 'finished' && raceOut.result === 'lost'
    && raceOut.decidedAt - raceOut.startedAt === 20 * 60 * 1000 && raceOut.problem.title === 'LRU Cache', JSON.stringify(raceOut));

r = await call('POST', '/v1/duels', { session: finn, body: { handle: 'erin', kind: 'race', hours: 1,
    problem: { key: 'Codeforces:1-A', title: '1A', link: 'https://codeforces.com/contest/1/problem/A' } } });
const idleRace = r.data.duel.id;
await call('POST', `/v1/duels/${idleRace}/accept`, { session: erin });
tick(2 * HOUR);
r = await call('GET', '/v1/duels', { session: finn });
check('a race nobody finishes is a draw', r.data.duels.find(d => d.id === idleRace).result === 'draw');

/* decline, cancel, expiry, forfeit */
const newSprint = async (from, to) => (await call('POST', '/v1/duels', { session: from, body: { handle: to, kind: 'sprint', hours: 72 } })).data.duel.id;
let id = await newSprint(erin, 'finn');
r = await call('POST', `/v1/duels/${id}/decline`, { session: finn });
r = await call('GET', `/v1/inbox?since=${clock - 1}`, { session: erin });
check('declining tells the challenger', r.data.events.some(e => e.type === 'duel_declined' && e.duel.id === id));
id = await newSprint(erin, 'finn');
r = await call('DELETE', `/v1/duels/${id}`, { session: finn });
check('only the challenger can withdraw', r.status === 409);
r = await call('DELETE', `/v1/duels/${id}`, { session: erin });
check('challenger withdraws', r.status === 200 && db.prepare('SELECT status FROM duels WHERE id = ?').get(id).status === 'cancelled');
id = await newSprint(erin, 'finn');
tick(49 * HOUR);
r = await call('POST', `/v1/duels/${id}/accept`, { session: finn });
check('an unanswered challenge lapses after 48 hours', r.status === 409);
id = await newSprint(erin, 'finn');
await call('POST', `/v1/duels/${id}/accept`, { session: finn });
r = await call('POST', `/v1/duels/${id}/forfeit`, { session: finn });
check('forfeit hands the win over', r.data.duel.result === 'lost' && r.data.duel.forfeited === 'you');
r = await call('GET', '/v1/duels', { session: erin });
check('record adds up', r.data.record.won === 2 && r.data.record.lost === 1 && r.data.record.drawn === 1, JSON.stringify(r.data.record));
r = await call('GET', `/v1/friends/finn?today=${day(0)}`, { session: erin });
check('head-to-head record on the friend view', r.data.record.won === 2 && r.data.record.lost === 1, JSON.stringify(r.data.record));

/* nudges */
r = await call('POST', '/v1/friends/finn/nudge', { session: erin });
check('nudge sent', r.status === 201);
r = await call('POST', '/v1/friends/finn/nudge', { session: erin });
check('one nudge per 12 hours', r.status === 429 && r.data.code === 'nudge_cooldown');
r = await call('GET', `/v1/inbox?since=${clock - 1}`, { session: finn });
check('nudge reaches the inbox', r.data.events.some(e => e.type === 'nudge' && e.from.handle === 'erin'));
r = await call('POST', '/v1/friends/gail/nudge', { session: erin });
check('only friends can be nudged', r.status === 404);
tick(13 * HOUR);
r = await call('POST', '/v1/friends/finn/nudge', { session: erin });
check('nudging again after the cooldown', r.status === 201);

/* sharing off, unfriend, delete */
await call('PATCH', '/v1/me', { session: finn, body: { sharing: false } });
r = await call('POST', '/v1/duels', { session: erin, body: { handle: 'finn', kind: 'sprint', hours: 24 } });
check('cannot duel someone not sharing', r.status === 409 && r.data.code === 'friend_not_sharing');
await call('PATCH', '/v1/me', { session: finn, body: { sharing: true } });
id = await newSprint(erin, 'finn');
await call('DELETE', '/v1/friends/erin', { session: finn });
check('unfriending calls off open duels', db.prepare('SELECT status FROM duels WHERE id = ?').get(id).status === 'cancelled');
await call('DELETE', '/v1/me', { session: erin });
check('deleting a profile removes its duels and nudges',
    db.prepare("SELECT COUNT(*) AS n FROM duels").get().n === 0 && db.prepare("SELECT COUNT(*) AS n FROM nudges").get().n === 0);

/* ── freezes, the weekly league, the crew feed, restore ────────────── */
{
    const d = day(0);
    const n0 = dayNumber(d);
    const at = offset => dayString(n0 + offset);
    const solve = (who, key, offset) => ({
        key: `Codeforces:${who}-${key}`, platform: 'Codeforces', title: `${who} ${key}`, difficulty: '800',
        link: `https://codeforces.com/contest/1/problem/${key}`, solutionUrl: null, solvedOn: at(offset)
    });

    const hank = (await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_hank_token_0000', handle: 'hank' } })).data.session;
    const ivy = (await call('POST', '/v1/auth/signup', { body: { githubToken: 'gho_ivy_token_00000', handle: 'ivy' } })).data.session;
    await call('POST', '/v1/friends', { session: hank, body: { handle: 'ivy' } });
    await call('POST', '/v1/friends/hank/accept', { session: ivy });

    // Seven straight days earn a freeze, which covers the missed day after.
    const hankDays = [-9, -8, -7, -6, -5, -4, -3, -1, 0];
    // Last week: hank 3 solves, ivy 1 — the crown is hank's.
    const lastMonday = weekStart(n0) - 7 - n0;
    await call('PUT', `/v1/me/submissions?today=${d}`, { session: hank, body: { submissions: [
        ...hankDays.map((o, i) => solve('h', `D${i}`, o)),
        solve('h', 'L1', lastMonday), solve('h', 'L2', lastMonday + 1), solve('h', 'L3', lastMonday + 2)
    ] } });
    await call('PUT', `/v1/me/submissions?today=${d}`, { session: ivy, body: { submissions: [
        ...[-9, -8, -7, -6, -5, -4, -3, -1, 0].map((o, i) => solve('i', `D${i}`, o)),
        solve('i', 'L1', lastMonday)
    ] } });

    r = await call('GET', `/v1/friends?today=${d}`, { session: ivy });
    const h = r.data.friends.find(f => f.handle === 'hank');
    check('a freeze carries a run over one missed day', h.stats.streak === 9 && h.stats.freezes === 0, JSON.stringify(h.stats));
    check('the shared streak takes a freeze too', h.together.streak === 9, JSON.stringify(h.together));
    check('league counts this calendar week', typeof h.stats.league === 'number'
        && r.data.league.weekStart === dayString(weekStart(n0)) && r.data.league.endsOn === dayString(weekStart(n0) + 7), JSON.stringify(r.data.league));
    const lastWeekKey = dayString(weekStart(n0) - 7);
    const crownFor = handle => db.prepare(
        'SELECT c.solves FROM crowns c JOIN users u ON u.id = c.user_id WHERE u.handle = ? AND c.week_start = ?'
    ).get(handle, lastWeekKey);
    check('ivy is not crowned for a week hank won', !crownFor('ivy') && r.data.me.crowns >= 0, JSON.stringify(r.data.me));
    check('crew feed lists friends\' recent solves, newest day first', r.data.feed.length > 0
        && r.data.feed.every(item => item.handle === 'hank') && r.data.feed[0].solvedOn === d, JSON.stringify(r.data.feed.slice(0, 2)));

    r = await call('GET', `/v1/friends?today=${d}`, { session: hank });
    const hankCrowns = r.data.me.crowns;
    check('the week\'s top solver gets a crown', crownFor('hank') && crownFor('hank').solves === 9
        && hankCrowns === r.data.friends.find(f => f.handle === 'ivy').crowns + 1, JSON.stringify(r.data.me));
    r = await call('GET', `/v1/friends?today=${d}`, { session: hank });
    check('crowns settle once', r.data.me.crowns === hankCrowns);

    r = await call('GET', `/v1/friends/hank?today=${d}`, { session: ivy });
    check('friend detail carries freezes, crowns and frozen days', r.data.stats.freezes === 0
        && r.data.profile.crowns === hankCrowns && r.data.stats.frozen.includes(at(-2)) && r.data.together.longest === 9, JSON.stringify(r.data));

    r = await call('GET', '/v1/me/submissions', { session: hank });
    check('own shared solves come back for a restore', r.status === 200 && r.data.submissions.length === 12
        && r.data.next === null && r.data.submissions.every(s => s.key.startsWith('Codeforces:h-')), JSON.stringify(r.data).slice(0, 300));
    r = await call('GET', `/v1/me/submissions?after=${encodeURIComponent('Codeforces:h-D8')}`, { session: hank });
    check('own solves page by key', r.data.submissions.length === 3 && r.data.submissions[0].key === 'Codeforces:h-L1', JSON.stringify(r.data));
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
if (failures) process.exitCode = 1;
