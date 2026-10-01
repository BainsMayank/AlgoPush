# AlgoPush — profiles, friends and duels backend

A Cloudflare Worker with a D1 database behind the popup's optional **Friends**
and **Duels** tabs. Syncing to GitHub never touches it; an install that never creates a
profile never sends it a request.

## What it stores

| Table | Holds |
| :--- | :--- |
| `users` | GitHub numeric id and login, the chosen handle and display name, GitHub avatar URL, whether solves are shared |
| `sessions` | SHA-256 hashes of session tokens — never the tokens themselves |
| `friendships` | Who asked whom, and whether it was accepted |
| `submissions` | Per solve: platform, title, difficulty, problem link, link to the solution folder on GitHub, the day it was solved, and `solved_at` for solves synced live. **No source code.** |
| `duels` | Race or sprint, the two people, the problem (race), duration, start/end, scores and winner |
| `nudges` | Who nudged whom, when (one per pair every 12 hours) |

Turning sharing off deletes the user's `submissions` rows. Deleting a profile
deletes every row that mentions the user.

## How sign-in works

There is no password. The extension already holds a GitHub token from
connecting its repository; signing in sends that token here once. The Worker
calls `GET https://api.github.com/user` with it to learn the GitHub account's
numeric id, then discards the token and issues its own random session token.
It never stores the GitHub token and cannot write to anyone's repository.

## API

All routes except the two sign-in routes take `Authorization: Bearer <session>`.
Friend-facing reads accept `?today=YYYY-MM-DD` (the viewer's local date, ±1 day
of UTC) so streaks are judged against the viewer's calendar.

| Route | Does |
| :--- | :--- |
| `POST /v1/auth/github` `{ githubToken }` | Sign in. `404 { code: "no_account", suggestion }` when this GitHub account has no profile yet |
| `POST /v1/auth/signup` `{ githubToken, handle, displayName, sharing }` | Create a profile |
| `POST /v1/auth/signout` | End this session |
| `GET` / `PATCH` / `DELETE /v1/me` | Read, edit (`displayName`, `sharing`), or delete the profile |
| `PUT /v1/me/submissions` `{ submissions: [...] }` | Upsert up to 500 solves, keyed like `syncedProblemsIndex` |
| `GET /v1/friends` | Friends with overview stats, plus incoming and outgoing requests |
| `POST /v1/friends` `{ handle }` | Send a request (accepts, if they already asked you) |
| `GET /v1/friends/:handle` | A friend's run, longest run, per-judge counts, last 35 days and 30 most recent solves |
| `POST /v1/friends/:handle/accept` | Accept a request |
| `DELETE /v1/friends/:handle` | Decline, withdraw, or unfriend (also calls off open duels between you) |
| `POST /v1/friends/:handle/nudge` | Nudge a friend; `429 nudge_cooldown` within 12 hours of the last |
| `GET /v1/duels` | Your W–L–D record, open duels with live scores, and the last 30 days of results |
| `POST /v1/duels` `{ handle, kind, hours, problem? }` | Challenge a friend. `race`: 1/24/72 h plus `problem: { key, title, link }`; `sprint`: 24/72/168 h |
| `POST /v1/duels/:id/accept` · `/decline` · `/forfeit` | Answer a challenge, or give up one in progress |
| `DELETE /v1/duels/:id` | Withdraw a challenge nobody has answered |
| `GET /v1/inbox?since=<ms>` | Events since the last check (requests, acceptances, nudges, challenges, results) and what is waiting on you |

### Friend streaks, duels and scoring

- The **together** streak is the run of days on which *both* people solved something.
- Duels are settled lazily — whenever either person next reads anything — and every settle
  is an `UPDATE … WHERE status = 'active'`, so concurrent readers agree. No cron needed.
- Only solves carrying `solved_at` count, and the extension stamps only live syncs, so
  importing history mid-duel changes nothing. Stamps in the future are clamped to now.
- A race on a problem either person already solved is refused, both when it is sent and
  when it is accepted. Unanswered challenges lapse after 48 hours.
- Scores come from what the extension uploads, so someone replaying their own session with
  curl could fake a solve. This is a game between friends, not an anti-cheat system.

A handle that is not your friend gets the same `404` as one that does not
exist, so profiles cannot be probed through the detail route.

## Deploy

```bash
cd social-backend
npm install
npx wrangler login
npx wrangler d1 create algopush-social      # first time only; paste the id into wrangler.toml
npm run migrate                              # applies any migration not yet applied
npm run deploy
```

Run `npm run migrate` before `npm run deploy`, and deploy the Worker before releasing an
extension version that calls new routes: the Worker expects the tables its migrations create.

The extension calls `DEFAULT_SOCIAL_API_URL` in `shared/social.js`
(`https://algopush-social.mynklabs.workers.dev`). A fork deploying under a
different name edits that constant.

### Optional settings

| Setting | Default | What it does |
| :--- | :--- | :--- |
| `ALLOWED_ORIGINS` (secret) | the extension's `chrome-extension://` origin | Comma-separated CORS allowlist. As with the Codeforces Worker, a request with no `Origin` is still served; the bearer session is the access control. |
| `RATE_LIMIT_KV` (KV binding) | unset | Makes the sign-in (10/min per IP) and friend-request (30 per 10 min per user) caps hold across isolates. |

## Tests

```bash
npm test
```

Runs the Worker against a real SQLite database (Node's built-in `node:sqlite`,
Node 22.13+) wearing a D1-shaped adapter, with GitHub mocked. Covers sign-up
and sign-in, hashed sessions, the request/accept/decline lifecycle, input
validation of shared solves (including `javascript:` links), streak maths,
sharing off, account deletion, CORS and rate limits.
