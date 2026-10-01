# Store assets

Everything in `out/` is generated. Edit the source, re-run, upload.

```bash
npm run store          # re-capture the popup, then render every asset
npm run store:render   # render only (skip the popup captures)
npm run icons          # regenerate images/icon*.png and the store icon
```

## What gets produced

| File | Size | Where it goes |
|---|---|---|
| `out/screenshot-1…5.png` | 1280×800 | Listing screenshots (max 5) |
| `out/tile-small.png` | 440×280 | Small promo tile — required |
| `out/tile-marquee.png` | 1400×560 | Marquee tile — needed only for featuring |
| `out/store-icon-128.png` | 128×128 | Store icon |
| `images/icon{16,32,48,128}.png` | — | Shipped in the extension, referenced by `manifest.json` |

## How it is built

`capture-popup.mjs` serves the repo over a local HTTP server, loads the real
`popup/popup.html` with `chrome.storage` and `fetch` stubbed against sample
state from `seed.mjs`, and screenshots the board, calendar, settings and setup
screens at 3x into `shots/`. The UI in the store art is therefore the shipped
UI — a change to `popup.css` lands in the art on the next run, and there is no
hand-built mock to drift out of step.

`render.mjs` lays those captures into `store/*.html`, renders each page at 2x
and resamples down to the exact pixel size the Web Store requires. Type stays
in the DOM in the product's own Archivo variable font; nothing is generated
from a text-to-image model.

## Editing

- Copy lives in `store/copy.mjs` — headlines, subheads, fact rows, the
  directory listing. Layout lives in `store/screenshot.html` and the two tile
  files; shared tokens are in `store/store.css`, mirroring `DESIGN.md`.
- Sample state lives in `seed.mjs`. It is invented in content and realistic in
  shape. `PRODUCT.md` forbids install counts, ratings, testimonials and
  timings, so none appear on any tile — every number shown is one the product
  actually derives from `syncedProblemsIndex`.
