// Renders every Chrome Web Store asset at its exact required pixel size.
// Each page is drawn at 2x and resampled down, which is what keeps hairlines
// and small caps clean instead of faintly smeared.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'marketing/out');

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

// Chrome Web Store sizes. Screenshots must be exactly 1280x800 or 640x400;
// the promo tiles are exactly 440x280 and 1400x560.
const TARGETS = [
    ...[1, 2, 3, 4, 5].map((n) => ({
        name: `screenshot-${n}`, url: `marketing/store/screenshot.html?n=${n}`, w: 1280, h: 800
    })),
    { name: 'tile-small',   url: 'marketing/store/tile-small.html',   w: 440,  h: 280 },
    { name: 'tile-marquee', url: 'marketing/store/tile-marquee.html', w: 1400, h: 560 }
];

const only = process.argv.slice(2);
const queue = only.length ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;

const { server, port } = await serve();
const browser = await chromium.launch();

for (const target of queue) {
    const page = await browser.newPage({
        viewport: { width: target.w, height: target.h },
        deviceScaleFactor: 2
    });
    await page.goto(`http://127.0.0.1:${port}/${target.url}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState('networkidle');

    const buf = await page.screenshot();
    await sharp(buf)
        .resize(target.w, target.h, { kernel: 'lanczos3' })
        // The store rejects screenshots with an alpha channel; flattening on the
        // ground colour also guarantees no stray transparency at the edges.
        .flatten({ background: '#15120E' })
        .png({ compressionLevel: 9 })
        .toFile(join(OUT, `${target.name}.png`));

    console.log(`rendered ${target.name}  ${target.w}x${target.h}`);
    await page.close();
}

await browser.close();
server.close();
