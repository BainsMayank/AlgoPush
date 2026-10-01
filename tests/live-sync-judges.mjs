// Live sync for Codeforces, AtCoder and CodeChef, end to end against the real
// unpacked extension. Each site is served from stand-in pages built from the
// live markup and API shapes, a new Accepted appears after the first poll, and
// GitHub is faked inside the service worker — so a pass means the submission
// went all the way to a commit. Runs offline, in about 45 seconds.
//
//   node tests/live-sync-judges.mjs
import { createRequire } from 'node:module';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(`${ROOT}/package.json`);
const { chromium } = require('playwright');

const T0 = Date.now();
const late = () => Date.now() - T0 > 9000;           // the "new" Accepted appears after the first poll
const apiHandles = new Set();
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const html = (route, body) => route.fulfill({ contentType: 'text/html', body });

const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');

// The test browser is invisible, but its notifications are not: macOS shows
// them on the real desktop. Nothing a test does should reach the user.
await sw.evaluate(() => { chrome.notifications.create = () => {}; });

// If the test browser dies, say so, rather than failing on whatever step ran
// next with Playwright's "Target page, context or browser has been closed".
let finished = false;
ctx.on('close', () => {
    if (!finished) console.error('The test browser closed before the test finished — Chromium exited or crashed.');
});
ctx.on('page', (p) => p.on('crash', () => console.error(`A test page crashed: ${p.url()}`)));

// A configured install, with GitHub faked inside the worker: every push runs the real sync path
// and lands as recorded PUTs instead of real commits.
await sw.evaluate(async () => {
  await chrome.storage.local.set({ githubOauthToken: 'fake-token', githubRepo: 'me/algos', cfOauthProfile: { handle: 'me_user' } });
  globalThis.__puts = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const ok = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (u.startsWith('https://api.github.com/')) {
      const method = (init.method || 'GET').toUpperCase();
      if (/\/repos\/me\/algos$/.test(u)) return ok({ default_branch: 'main' });
      if (u.includes('/git/ref/heads/')) return ok({ object: { sha: 'abc' } });
      if (method === 'GET') return ok({ message: 'Not Found' }, 404);
      if (method === 'PUT') { const b = JSON.parse(init.body); globalThis.__puts.push({ path: decodeURIComponent(u.split('/contents/')[1].split('?')[0]), content: decodeURIComponent(escape(atob(b.content))) }); return ok({ content: { sha: 'x' } }, 201); }
      return ok({});
    }
    if (u.includes('kenkoooo.com')) return ok([]);
    if (u.includes('codechef.com')) return ok({}, 404);
    return real(url, init);
  };
});

/* ── Codeforces ─────────────────────────────────────────────────────── */
const cfPage = (signedIn) => `<!doctype html><html><head><meta name="X-Csrf-Token" content="0123456789abcdef0123456789abcdef"><title>My Submissions - Codeforces</title></head><body>
<table class="status-frame-datatable"><tr><td><a href="/profile/stranger_one">stranger_one</a></td></tr></table>
<div id="header"><div class="lang-chooser"><div>${signedIn ? '<a href="/profile/me_user">me_user</a> | <a href="/abc/logout">Logout</a>' : '<a href="/enter">Enter</a> | <a href="/register">Register</a>'}</div></div></div>
</body></html>`;
await ctx.route('https://codeforces.com/**', async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/user.status') {
    const handle = url.searchParams.get('handle'); apiHandles.add(handle);
    const sub = (id, verdict, contest = 1850, index = 'A', name = 'Old Problem') => ({ id, contestId: contest, creationTimeSeconds: Math.floor(Date.now() / 1000) - 30, problem: { contestId: contest, index, name, rating: 800, tags: ['math'] }, programmingLanguage: 'GNU C++20 (64)', verdict });
    const result = late() ? [sub(105, 'OK', 1850, 'G', 'Ten Words of Wisdom'), sub(104, 'WRONG_ANSWER', 1850, 'F'), sub(100, 'OK')] : [sub(100, 'OK')];
    return json(route, { status: 'OK', result });
  }
  if (url.pathname === '/data/submitSource') {
    const id = new URLSearchParams(route.request().postData()).get('submissionId');
    return json(route, { source: `int main() { return 0; } // submission ${id}\r\n` });
  }
  if (url.pathname === '/') return html(route, cfPage(true));
  return html(route, cfPage(!url.pathname.includes('signed-out')));
});

/* ── AtCoder ────────────────────────────────────────────────────────── */
const acRow = (id, status, task = 'abc400_a', title = 'A - Four Hidden') => `<tr><td class="text-center"><time class="fixtime-second">2026-09-30 21:34:56+0900</time></td>
<td><a href="/contests/abc400/tasks/${task}">${title}</a></td><td><a href="/users/me_user">me_user</a></td>
<td><a href="/contests/abc400/submissions?f.Language=5001">C++ 20 (gcc 12.2)</a></td><td class="text-right">100</td><td class="text-right">300 Byte</td>
<td class="text-center"><span class="label label-success">${status}</span></td><td class="text-right">1 ms</td><td class="text-right">3500 KiB</td>
<td class="text-center"><a href="/contests/abc400/submissions/${id}">Detail</a></td></tr>`;
await ctx.route('https://atcoder.jp/**', async (route) => {
  const url = new URL(route.request().url());
  const shell = (inner) => `<!doctype html><html><head><title>AtCoder</title><script>var userScreenName = "me_user";</script></head><body><div class="navbar"><a class="username" href="/users/me_user">me_user</a></div>${inner}</body></html>`;
  if (url.pathname === '/contests/abc400/submissions/me') {
    const rows = [acRow(500, 'AC')];
    if (late()) rows.unshift(acRow(510, 'AC', 'abc400_c', 'C - 2^a b^2'), acRow(509, '12/40', 'abc400_b'));
    return html(route, shell(`<table class="table"><thead><tr><th>Submission Time</th><th>Task</th><th>User</th><th>Language</th><th>Score</th><th>Code Size</th><th>Status</th><th>Exec Time</th><th>Memory</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`));
  }
  const m = url.pathname.match(/\/submissions\/(\d+)$/);
  if (m) return html(route, shell(`<table><tr><th>Task</th><td><a href="/contests/abc400/tasks/abc400_c">C - 2^a b^2</a></td></tr><tr><th>Language</th><td>C++ 20 (gcc 12.2)</td></tr></table><pre id="submission-code">#include &lt;bits/stdc++.h&gt;\n// submission ${m[1]}</pre>`));
  return html(route, shell('<p>contest</p>'));
});

/* ── CodeChef ───────────────────────────────────────────────────────── */
const ccRow = (id, verdict, code) => `<tr class='kol'><td title='09:10 PM 30/09/26'>09:10 PM 30/09/26</td><td title='${code}'><a href='/problems/${code}'>${code}</a></td><td><span title='${verdict}'><img src='x.svg'/></span></td><td title='C++'>C++</td><td class='centered' style='width:60px;' title='View'><a href='/viewsolution/${id}' target='_blank'>View</a></td></tr>`;
await ctx.route('https://www.codechef.com/**', async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/user/me') return json(route, { status: 'OK', user: { username: 'me_user', rating: 1650, profileImagePath: null, fullName: 'Me' } });
  if (url.pathname === '/recent/user') {
    const rows = [ccRow(700, 'accepted', 'FLOW001')];
    if (late()) rows.unshift(ccRow(710, 'accepted', 'START01'), ccRow(709, 'partially accepted', 'PARTIAL1'));
    return json(route, { max_page: 1, content: `<table><tbody>${rows.join('')}</tbody></table>` });
  }
  const code = url.pathname.match(/\/api\/submission-code\/(\d+)/);
  if (code) return json(route, { status: 'OK', data: { code: `print("submission ${code[1]}")`, language: { full_name: 'Python 3', short_name: 'PYTH 3', extension: 'py' } } });
  if (url.pathname.startsWith('/api/contests/')) return json(route, { status: 'success', problem_name: 'Number Mirror', difficulty_rating: 1100, user_tags: ['basic'] });
  return html(route, '<!doctype html><html><head><title>CodeChef</title></head><body>codechef</body></html>');
});

const pages = [];
for (const url of ['https://codeforces.com/contest/1850/my', 'https://atcoder.jp/contests/abc400/submissions/me', 'https://www.codechef.com/problems/FLOW001']) {
  const p = await ctx.newPage(); await p.goto(url); pages.push(p);
}
// Only one tab is ever "visible" in a real window; the pollers pause in hidden tabs. Force visible so all three poll.
for (const p of pages) await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'visible' }); });
await new Promise(r => setTimeout(r, 30000));

const puts = await sw.evaluate(() => globalThis.__puts);
const solutions = puts.filter(p => /\/solution\.[a-z0-9]+$/.test(p.path));
const idx = await sw.evaluate(async () => (await chrome.storage.local.get('syncedProblemsIndex')).syncedProblemsIndex || {});
let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const one = (re) => solutions.filter(s => re.test(s.path));
check('Codeforces: new Accepted committed exactly once', one(/^Codeforces\/800\/Ten-Words-of-Wisdom\/solution\.cpp$/).length === 1 && one(/^Codeforces\//).length === 1, JSON.stringify(solutions.map(s => s.path)));
check('Codeforces: source intact (CRLF normalised)', (one(/^Codeforces\//)[0] || {}).content === 'int main() { return 0; } // submission 105\n', JSON.stringify(one(/^Codeforces\//)[0]));
check('Codeforces: only the signed-in handle was ever polled', [...apiHandles].join(',') === 'me_user', [...apiHandles].join(','));
check('AtCoder: new AC committed once; the 12/40 in-progress row skipped', one(/^AtCoder\//).length === 1 && /submission 510/.test(one(/^AtCoder\//)[0].content), JSON.stringify(one(/^AtCoder\//)));
check('CodeChef: new AC committed once; "partially accepted" skipped', one(/^CodeChef\//).length === 1 && /submission 710/.test(one(/^CodeChef\//)[0].content) && /\.py$/.test(one(/^CodeChef\//)[0].path), JSON.stringify(one(/^CodeChef\//)));
check('Old solves already on screen at first poll are not backfilled', !solutions.some(s => /submission (100|500|700)\b/.test(s.content)), JSON.stringify(solutions.map(s => s.content.slice(-20))));
const acEntry = Object.entries(idx).find(([k]) => k.startsWith('AtCoder:'));
check('AtCoder: dated from the judge time, stamped as live', acEntry && acEntry[1].date === '2026-09-30' && acEntry[1].solvedAt === Date.parse('2026-09-30T21:34:56+09:00'), JSON.stringify(acEntry));
const cfEntry = Object.entries(idx).find(([k]) => k.startsWith('Codeforces:'));
check('Codeforces: stamped with the judge time', cfEntry && Math.abs(cfEntry[1].solvedAt - Date.now()) < 120000, JSON.stringify(cfEntry));

// Signed out, and signed in as a different account: nothing may be polled.
for (const p of pages) await p.close();
await new Promise(r => setTimeout(r, 1000));
apiHandles.clear();
const out = await ctx.newPage(); await out.goto('https://codeforces.com/contest/1850/signed-out');
await out.evaluate(() => { Object.defineProperty(document, 'visibilityState', { get: () => 'visible' }); });
await sw.evaluate(() => chrome.storage.local.set({ cfOauthProfile: { handle: 'someone_else' } }));
const other = await ctx.newPage(); await other.goto('https://codeforces.com/contest/1850/my');
await new Promise(r => setTimeout(r, 7000));
check('Codeforces signed out: the stranger in the table is never polled', !apiHandles.has('stranger_one'), [...apiHandles].join(','));
check('Codeforces signed in as another account: live sync pauses', !apiHandles.has('me_user'), [...apiHandles].join(','));

console.log(`\ncommits: ${solutions.map(s => s.path).join(' | ')}`);
if (fail) process.exitCode = 1;
finished = true;
await ctx.close();
