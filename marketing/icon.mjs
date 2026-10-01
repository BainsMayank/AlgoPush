// The mark: a push arrow standing on a baseline. Flat, zero radius, two
// colours — the same rules the popup follows, at 16px.
import sharp from 'sharp';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect width="128" height="128" fill="#15120E"/>
  <path d="M64 18 94 60 74 60 74 92 54 92 54 60 34 60 Z" fill="#F4F1EA"/>
  <rect x="34" y="102" width="60" height="10" fill="#FF5436"/>
</svg>`;

// 16 and 32 are the toolbar sizes; rendering each from the same geometry keeps
// the arrow on whole pixels instead of downsampling a 128 into mush.
for (const size of [16, 32, 48, 128]) {
    const out = size === 128
        ? join(ROOT, 'images/icon128.png')
        : join(ROOT, `images/icon${size}.png`);
    await sharp(Buffer.from(svg(size))).png({ compressionLevel: 9 }).toFile(out);
    console.log(`icon ${size}`);
}

// Store listing icon: the same mark with the safe-area inset the Web Store
// expects, so the arrow is not flush to the tile edge in the gallery.
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" fill="#15120E"/>
  <g transform="translate(64 64) scale(0.78) translate(-64 -64)">
    <path d="M64 18 94 60 74 60 74 92 54 92 54 60 34 60 Z" fill="#F4F1EA"/>
    <rect x="34" y="102" width="60" height="10" fill="#FF5436"/>
  </g>
</svg>`)).png({ compressionLevel: 9 }).toFile(join(ROOT, 'marketing/out/store-icon-128.png'));
console.log('store icon');
