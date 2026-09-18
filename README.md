# AlgoPush

A Chrome extension that syncs your **Accepted** submissions from LeetCode,
Codeforces, AtCoder and CodeChef to a GitHub repository, organised by platform
and difficulty, with a generated index.

## Layout

| Path | What it is |
| :--- | :--- |
| `manifest.json` | MV3 manifest. Its `key` pins the extension id, which the Codeforces OAuth redirect URI depends on — do not remove it. |
| `background/` | Service worker: the sync queue, README generation, and the per-platform catch-up passes that run with no tab open. |
| `content-scripts/` | One script per judge, plus `common.js` (loaded first, shares the anti-bot detection and the drain lock). These are **not** modules. |
| `shared/` | ES modules used by the service worker, options page and popup. |
| `options/`, `popup/` | Extension UI. |
| `oauth-backend/` | Cloudflare Worker for the Codeforces OIDC code exchange. **Not part of the extension bundle.** |
| `scripts/pack.sh` | Builds the Web Store zip from an allowlist. |

## Building the extension zip

```bash
./scripts/pack.sh
```

Writes `dist/algopush-<version>.zip`. The script ships an explicit allowlist
rather than excluding patterns, because this repository sits next to material
that must never be published — `.secrets/` holds the extension's **private
signing key**, and `oauth-backend/` holds the Worker's dev vars and local
state. It also refuses to package a placeholder icon.

## Backend

See [oauth-backend/README.md](oauth-backend/README.md) for deploying the
Codeforces exchange Worker and `npm test` for its security test suite.

## Why each platform works differently

Only Codeforces publishes an OAuth/OIDC provider, and its token endpoint
requires a client secret — hence the Worker. LeetCode, AtCoder and CodeChef
publish no third-party app registration at all, so "connect account" for those
three asks the site itself, from a real signed-in tab, which account the
browser belongs to (`shared/tab-rpc.js`). No password ever reaches the
extension, and submission source is always read from the user's own session.
