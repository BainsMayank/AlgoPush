# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Competitive programmers and interview-prep solvers — students and new grads most of all —
who solve on LeetCode, Codeforces, AtCoder and CodeChef and want that work to show up on
GitHub without thinking about it. The audience spans casual grinders and contest regulars,
but the promise leans portfolio: proof-of-work a recruiter can see, with a durable personal
archive as the second-order benefit.

The user is mid-session when they meet this product — a browser tab open on a judge, a
submission just accepted. They are not in a configuration mood.

## Product Purpose

AlgoPush watches the judges the user already uses and pushes every Accepted submission to
their own GitHub repository, filed by platform and difficulty, with a README index kept
current. Success is the user forgetting the extension exists and finding a well-organized
repo of everything they have solved.

## Positioning

Zero-effort automation. The sync fires the moment a judge confirms Accepted — no manual
trigger, no copy-paste, no cron, no "sync now" ritual. Committing solutions by hand is the
thing this replaces; anything in the interface that asks the user to trigger a sync
contradicts the product.

Supporting, not headline: four platforms land in one consistently organized repo; no
password ever touches the extension; already-solved history can be backfilled resumably.

## Excel Together

AlgoPush's second promise, opt-in and never in the way of the first: friends keep each other
going. A profile (the GitHub account is the sign-in) unlocks a streak kept *together* — the
days both people solved something — a weekly board, nudges, and duels: a race to the first
Accepted on one problem, or a sprint for the most solves in a window. Everything is scored
from the solves that already sync; a duel never asks anyone to report a result.

Motivation here means accountability between people who chose each other, not public
rankings. There is no global leaderboard and no stranger discovery: you find a friend by
the exact handle they gave you.

## Operating Context

- Lives entirely in the browser: a Manifest V3 Chrome extension with a toolbar popup, an
  options page, a background service worker and per-judge content scripts.
- The popup is a browser-action panel, roughly 360–400px wide, with a practical height
  ceiling near 600px. It opens for seconds at a time and closes on any outside click.
- Connections are made through each platform's own auth: a GitHub App install for GitHub,
  Codeforces' OpenID Connect for Codeforces, and signed-in-session verification for
  LeetCode, AtCoder and CodeChef (none of the three publish third-party OAuth).
- Historical imports run in a background tab against the user's own signed-in session and
  are resumable; anything already pushed is skipped.

## Capabilities and Constraints

- Stack is fixed by the existing codebase: plain HTML, CSS and ES modules, no build step,
  no framework, no bundler. Manifest V3 CSP forbids inline script and remote script.
- All popup state comes from `chrome.storage.local`. The keys that matter here:
  `githubOauthToken` / `githubToken` (resolved via `getEffectiveGithubToken`),
  `githubOauthProfile`, `githubRepo`, `cfOauthProfile`, `lcProfile`, `acProfile`,
  `ccProfile`, `enableLeetCode` / `enableCodeforces` / `enableAtCoder` / `enableCodeChef`,
  `syncedProblemsIndex` (every synced problem: title, platform, difficulty, tags, link,
  folderUrl, date), `syncHistory` (last 50 syncs), and `lastError`.
- `syncedProblemsIndex` is the only source of durable achievement data — totals, per-platform
  counts and day-streaks are all derivable from it. No new background work is needed to
  show them, and no new counter should be invented alongside it.
- Connect flows live in `options/options.js` and today assume the options page's DOM. Any
  connect action offered in the popup must either reuse that logic or hand off to the
  options page; it must not fork a second copy of an auth flow.
- The platform enable flags already exist and gate syncing in the service worker. "Which
  platforms do you use" is that same fact, asked at the right moment.
- Terminology: platforms are LeetCode, Codeforces, AtCoder, CodeChef (exact casing).
  Submissions are "Accepted". The destination is the user's own repo.

## Brand Commitments

Name is AlgoPush. The only existing asset is `images/icon128.png`. No wordmark, palette,
typeface or voice has been committed — those are open for the visual world to decide.

## Evidence on Hand

Real: four working judge integrations, a working GitHub App install flow, a resumable
historical importer, a live sync path proven end to end at v1.5.0.

Absent, and not to be fabricated: user counts, install numbers, testimonials, ratings,
star counts, named users, benchmark timings, or any claim about how many people use this.
The extension is not yet a Chrome Web Store hit and the interface must not imply it is.

## Product Principles

1. **The product's value is that nothing is asked of you.** Every element must justify
   itself against the alternative of the user seeing nothing at all.
2. **Setup is the only moment the user owes the product attention.** Spend that moment
   well, ask for the minimum, and never ask twice.
3. **Ask only what applies.** A user who solves on two platforms should never be shown
   the other two as unfinished work.
4. **Show earned progress, not invented metrics.** Everything on screen must trace to a
   real record in `syncedProblemsIndex` or `syncHistory`.
5. **Never contradict the automation.** No "sync now" button, no manual trigger, no
   interface that implies the user must act for the product to work.
6. **The social layer is optional and additive.** Syncing never waits on it, setup never
   requires it, and a user without a profile never sees it as unfinished work.
7. **Only live solves compete.** Imports fill history and streak calendars, but a duel is
   scored only from solves synced as they happened, so nobody wins by importing.

## Accessibility & Inclusion

Keyboard operation and visible focus are required — a popup dismisses on outside click, so
trapping or losing focus is unrecoverable. Status must never be carried by color alone;
connection and sync state need a text or shape signal too. Respect
`prefers-reduced-motion`. Target contrast is WCAG AA.
