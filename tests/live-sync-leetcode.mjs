// Live LeetCode sync, end to end against the real unpacked extension.
//
// leetcode.com is served from stand-in pages that replay the request sequence
// the live site makes (submit, then result polling, then GraphQL), so this
// runs offline and signed out. It exists because LeetCode moved result
// polling to `/submissions/detail/<id>/v2/check/` and live sync broke with no
// error anywhere; each scenario below is a shape the site has used or might.
//
//   node tests/live-sync-leetcode.mjs
import { createRequire } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(`${ROOT}/package.json`);
const { chromium } = require('playwright');

// What the page's own result poll returns, and what GraphQL reports.
const SCENARIOS = {
    9001: { name: 'v2 poll, Accepted', check: 'v2', result: { state: 'SUCCESS', status_code: 10, status_runtime: '0 ms' }, gql: 10, expect: true },
    9002: { name: 'v1 poll, Accepted', check: 'v1', result: { state: 'SUCCESS', status_msg: 'Accepted', status_code: 10 }, gql: 10, expect: true },
    9003: { name: 'unknown future poll format, GraphQL alone', check: 'v9', result: { verdict: 'ok' }, gql: 10, expect: true },
    9004: { name: 'Wrong Answer', check: 'v2', result: { state: 'SUCCESS', status_code: 11, status_msg: 'Wrong Answer' }, gql: 11, expect: false }
};

const PAGE = `<!doctype html><html><head><title>Two Sum - LeetCode</title></head><body>
<script>
window.runSubmit = async (id, check, run) => {
  const endpoint = run ? '/problems/two-sum/interpret_solution/' : '/problems/two-sum/submit/';
  const r = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ lang: 'python3', typed_code: 'class Solution: # ' + id, question_id: '1' }) });
  const { submission_id } = await r.json();
  const path = check === 'v1' ? '/submissions/detail/' + submission_id + '/check/' : '/submissions/detail/' + submission_id + '/' + check + '/check/';
  await fetch(path);                                  // still judging
  await new Promise(r => setTimeout(r, 300));
  await fetch(path);                                  // verdict
};
</script></body></html>`;

const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });

const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');

// The test browser is invisible, but its notifications are not: macOS shows
// them on the real desktop. Nothing a test does should reach the user.
await sw.evaluate(() => {
    globalThis.__silenced = 0;
    chrome.notifications.create = () => { globalThis.__silenced += 1; };
});

// If the test browser dies, say so, rather than failing on whatever step ran
// next with Playwright's "Target page, context or browser has been closed".
let finished = false;
ctx.on('close', () => {
    if (!finished) console.error('The test browser closed before the test finished — Chromium exited or crashed.');
});
ctx.on('page', (p) => p.on('crash', () => console.error(`A test page crashed: ${p.url()}`)));

// Record what reaches the service worker. GitHub is not configured in this
// profile, so every push fails — which is also how the retry queue is tested.
await sw.evaluate(() => {
    globalThis.__got = [];
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'SUBMISSION_ACCEPTED') globalThis.__got.push(message);
    });
});

const polls = {};
await ctx.route('https://leetcode.com/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path.startsWith('/problems/two-sum') && request.method() === 'GET') {
        return route.fulfill({ contentType: 'text/html', body: PAGE });
    }
    if (path.endsWith('/submit/') || path.endsWith('/interpret_solution/')) {
        const id = JSON.parse(request.postData()).typed_code.split('# ')[1];
        return json(route, path.endsWith('/submit/')
            ? { submission_id: Number(id) }
            : { interpret_id: `run_${id}`, submission_id: Number(id) });
    }
    const detail = path.match(/\/submissions\/detail\/(\d+)\//);
    if (detail) {
        polls[detail[1]] = (polls[detail[1]] || 0) + 1;
        const scenario = SCENARIOS[detail[1]] || SCENARIOS[9001];
        return json(route, polls[detail[1]] === 1 ? { state: 'PENDING' } : scenario.result);
    }
    if (path.startsWith('/graphql')) {
        const { query, variables } = JSON.parse(request.postData());
        if (query.includes('submissionDetails')) {
            const scenario = SCENARIOS[String(variables.submissionId)];
            if (!scenario) return json(route, { data: { submissionDetails: null } });
            return json(route, { data: { submissionDetails: {
                code: `class Solution: # ${variables.submissionId}`,
                timestamp: String(Math.floor(Date.now() / 1000) - 5),
                statusCode: scenario.gql,
                lang: { name: 'python3' },
                question: { titleSlug: 'two-sum' }
            } } });
        }
        if (query.includes('questionData')) {
            return json(route, { data: { question: { title: 'Two Sum', difficulty: 'Easy', topicTags: [{ name: 'Array' }] } } });
        }
        return json(route, { data: {} });
    }
    return route.fulfill({ status: 204, body: '' });
});

const page = await ctx.newPage();
await page.goto('https://leetcode.com/problems/two-sum/description/');
await page.waitForTimeout(1500);
for (const id of Object.keys(SCENARIOS)) {
    await page.evaluate(([id, check]) => window.runSubmit(id, check), [id, SCENARIOS[id].check]);
}
await page.evaluate(() => window.runSubmit('9005', 'v2', true));   // a "Run", never a submit
await page.waitForTimeout(9000);

const got = await sw.evaluate(() => globalThis.__got);
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
    if (!ok) failures += 1;
};

for (const [id, scenario] of Object.entries(SCENARIOS)) {
    const hits = got.filter((message) => message.submissionId === id);
    const ok = scenario.expect
        ? hits.length === 1 && hits[0].slug === 'two-sum' && hits[0].code.includes(id) && hits[0].title === 'Two Sum'
        : hits.length === 0;
    check(`${scenario.name}: ${scenario.expect ? 'pushed once' : 'not pushed'}`, ok, `${hits.length} push(es)`);
}
check('"Run" (interpret_solution) pushes nothing', got.every((message) => message.submissionId !== '9005'));

const queue = await sw.evaluate(async () => (await chrome.storage.local.get('lcPendingSubmissions')).lcPendingSubmissions || []);
const queued = queue.map((item) => item.submissionId).sort().join(',');
check('failed pushes queued once each for retry', queued === '9001,9002,9003', queued);

const silenced = await sw.evaluate(() => globalThis.__silenced);
check('its "connect GitHub" notifications were kept off the desktop', silenced > 0, `${silenced} silenced`);

finished = true;
await ctx.close();
console.log(failures ? `\n${failures} failing` : '\nall passing');
if (failures) process.exitCode = 1;
