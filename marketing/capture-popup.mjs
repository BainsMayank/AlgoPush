// Captures the real popup — real markup, real CSS, real render path — against
// sample state. Nothing here re-implements the UI, so a change to popup.css
// shows up in the store art on the next run.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './seed.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'marketing/shots');

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.json': 'application/json'
};

function serve() {
    return new Promise((resolve) => {
        const server = createServer(async (req, res) => {
            const path = join(ROOT, normalize(decodeURIComponent(req.url.split('?')[0])));
            try {
                const body = await readFile(path);
                res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
                res.end(body);
            } catch {
                res.writeHead(404).end('not found');
            }
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

const STUB = (seed) => {
    const store = { ...seed };

    const pick = (keys) => {
        if (keys === undefined || keys === null) return { ...store };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
    };

    globalThis.chrome = {
        storage: {
            local: {
                get: async (keys) => pick(keys),
                set: async (values) => { Object.assign(store, values); },
                remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
            },
            onChanged: { addListener() {} }
        },
        runtime: {
            openOptionsPage() {},
            sendMessage: async () => ({ ok: true }),
            getURL: (p) => p,
            onMessage: { addListener() {} },
            lastError: null
        },
        tabs: { create() {}, query: async () => [] },
        notifications: { create() {} },
        alarms: { clear: async () => {}, create() {} }
    };

    // The popup's only network call is a repo reachability check. Answering it
    // locally keeps the capture offline and deterministic.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (String(url).startsWith('https://api.github.com/')) {
            return new Response(JSON.stringify({
                full_name: 'yourname/algorithm-solutions',
                default_branch: 'main',
                permissions: { push: true, pull: true, admin: true }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return realFetch(url, init);
    };
};

const SHOTS = [
    {
        name: 'popup-stats',
        async prepare(page) { await page.waitForSelector('#screenBoard:not([hidden])'); }
    },
    {
        name: 'popup-calendar',
        async prepare(page) {
            await page.waitForSelector('#screenBoard:not([hidden])');
            await page.click('#tabCalendar');
            await page.waitForSelector('#panelCalendar:not([hidden])');
        },
        // End on the fourth arrival's own rule rather than partway through a row.
        clipTo: () => document.querySelectorAll('.arrival')[3].getBoundingClientRect().bottom
    },
    {
        name: 'popup-settings',
        async prepare(page) {
            await page.waitForSelector('#screenBoard:not([hidden])');
            await page.click('#tabSettings');
            await page.waitForSelector('#panelSettings:not([hidden])');
        },
        clipTo: () => document.querySelectorAll('#importList li')[2].getBoundingClientRect().bottom
    },
    {
        name: 'popup-lines',
        // The judge picker is built at boot from the same state either way, so
        // swapping the visible screen shows the real step-2 markup.
        async prepare(page) {
            await page.waitForSelector('#screenBoard:not([hidden])');
            await page.evaluate(() => {
                for (const s of document.querySelectorAll('.screen')) s.hidden = true;
                document.getElementById('screenLines').hidden = false;
                document.getElementById('linesNextBtn').disabled = false;
            });
        }
    }
];

const { server, port } = await serve();
const browser = await chromium.launch();
const seed = buildSeed();

for (const shot of SHOTS) {
    const page = await browser.newPage({
        viewport: { width: 400, height: 700 },
        deviceScaleFactor: 3
    });
    await page.addInitScript(STUB, seed);
    await page.goto(`http://127.0.0.1:${port}/popup/popup.html`);
    await shot.prepare(page);

    await page.evaluate(() => document.fonts.ready);
    // The rail fill and screen slide are the only continuous motion; let them settle.
    await page.waitForTimeout(700);

    // page.screenshot is the call that honours `clip`; the locator form ignores it.
    const height = shot.clipTo
        ? await page.evaluate(shot.clipTo)
        : await page.evaluate(() => document.body.getBoundingClientRect().height);

    await page.screenshot({
        path: join(OUT, `${shot.name}.png`),
        clip: { x: 0, y: 0, width: 400, height: Math.round(height) }
    });
    console.log(`captured ${shot.name}`);
    await page.close();
}

await browser.close();
server.close();
