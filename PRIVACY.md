# AlgoPush — Privacy Policy

**Last updated:** <!-- REPLACE with the date you publish, e.g. 19 October 2026 -->

AlgoPush is a Chrome extension that copies your own Accepted competitive-programming
submissions into a GitHub repository that you own and control, and — only if you opt in —
lets you keep streaks and run duels with friends.

The short version: **by default, AlgoPush has no server that stores your data.** There is
no analytics, no tracking, and no advertising. Everything the extension knows about you
stays in your own browser, and everything it writes goes to your own GitHub repository.

The one exception is **optional**: if you create a profile to use the Friends and Duels
tabs, a small amount of data is stored on AlgoPush's server so that friends you add can see
it. Nothing is sent until you create a profile, and you can delete it at any time. See
section 3.

---

## 1. What is stored, and where

All data the extension keeps is held in `chrome.storage.local` — Chrome's own per-device
extension storage, on your computer. None of it is transmitted to the developer, and
none of it is accessible to anyone else.

| What | Why it exists |
| :--- | :--- |
| GitHub access token and refresh token | To commit files to the repository you chose |
| Your GitHub username and avatar URL | To show which account is connected |
| The destination repository name | To know where to push |
| Your handle on each judge, plus public rating or rank | To show which account is connected, and to fetch only your own submissions |
| An index of synced problems — title, platform, difficulty, tags, problem link, file path, the day it was solved, and for solves synced live, the time | To avoid pushing the same solution twice, to build the repository's README index, and to count your daily run |
| A history of the last 50 pushes | To show recent activity in the popup |
| Which judges you enabled | To watch only the sites you chose |
| Whether you want the evening "run at risk" reminder, and the last day it was shown | So it is shown at most once a day, and never if you turned it off |
| Only if you create a profile: your AlgoPush session token, profile, a copy of your friends list, and the time you last checked for friend and duel news | To stay signed in, show the Friends tab without waiting, and notify you of each event once |

Uninstalling the extension deletes all of it. You can also disconnect any account from
the extension's settings at any time, which removes the corresponding tokens and profile.

**AlgoPush never handles your passwords.** GitHub is connected using GitHub's own device
authorization flow, where you type a short code on github.com. The competitive-programming
judges are not asked for credentials at all — AlgoPush reads only from the session you are
already signed in to in your own browser.

## 2. What leaves your browser, and to whom

AlgoPush makes network requests only to the following destinations, only for the purposes
listed, and only as a direct result of something you did.

**To GitHub (`api.github.com`, `github.com`)**
Your solution's source code, the problem title, difficulty, tags and a link to the problem,
written as commits to the repository you selected, using your own GitHub token. This is the
core function of the extension. It is sent to GitHub, not to the developer.

**To the judges you enabled (`leetcode.com`, `codeforces.com`, `atcoder.jp`, `codechef.com`)**
Requests made from your own signed-in browser session to read your own submissions and
their source code. AlgoPush sends no credentials of its own; these requests carry the
cookies your browser already has, exactly as if you had loaded the page yourself.

**To AtCoder Problems (`kenkoooo.com`) — only if you enable AtCoder**
AtCoder publishes no API of its own, so AlgoPush uses the community-run AtCoder Problems
dataset for problem metadata and difficulty estimates. Fetching your AtCoder submission
list sends your AtCoder handle to that service. Problem metadata requests are anonymous.
AtCoder Problems is operated by a third party and is not covered by this policy.

**To the AlgoPush Codeforces exchange service (`algopush-cf-oauth.mynklabs.workers.dev`) —
only when you press "Connect Codeforces Account"**
Codeforces' OpenID Connect token endpoint requires a client secret, which cannot safely be
shipped inside an extension. A small Cloudflare Worker holds that secret and performs the
exchange. When you connect Codeforces, and at no other time, the extension sends the
one-time authorization code Codeforces just issued, plus the public client identifier. The
Worker exchanges it with Codeforces, verifies the signed ID token, and returns only your
Codeforces handle, public rating and avatar URL.

The Worker does not store the authorization code, the access token, the ID token, or your
handle. The only thing it writes down is an abuse-prevention counter keyed by IP address,
which expires automatically after 60 seconds. Cloudflare, as the hosting provider, may
process request metadata under its own terms.

## 3. Optional profiles and friends

This section applies only if you choose to create a profile, from the popup's Settings tab
or the optional last step of setup. Without a profile, none of it happens.

**Signing in.** Your AlgoPush profile is tied to your GitHub account; there is no password.
When you create a profile or sign in, the extension sends the GitHub token it already holds
to the AlgoPush profile service (`algopush-social.mynklabs.workers.dev`), once. The service
asks GitHub which account the token belongs to, then discards the token. It never stores
your GitHub token and has no ability to write to your repositories.

**What the service stores.**

| What | Who can see it |
| :--- | :--- |
| Your GitHub account id and username, the handle and display name you choose, your GitHub avatar URL | You, and people you are friends with or have a pending request with |
| If sharing is on: for each synced solve, the platform, problem title, difficulty, a link to the problem, a link to the solution folder in your GitHub repository, the day it was solved, and for solves synced live, the time | You, and people you have accepted as friends (the time is used to score duels) |
| Your friend requests and friendships | You and the other person |
| Duels you send or accept: who against whom, the kind, the problem for a race, the time limit, when it started and ended, the score and the result | You and your opponent |
| Nudges you send: who nudged whom, and when | You and the person you nudged |
| A hash of your session token (not the token itself) | Nobody; it is only compared on each request |

**Your source code is never sent to the profile service.** A friend who follows the
solution link sees your code only if your GitHub repository is public; GitHub's own
permissions decide that.

**Duels are scored from the same solves.** A duel's score comes from the solves the
extension already shares; nothing extra is sent. Only solves synced live carry a time, so
importing old solutions never counts toward a duel.

**Notifications.** While you have a profile, the extension asks the service every ten
minutes whether anything happened to you — a friend request, a nudge, a challenge, a duel
result — and shows each as a Chrome notification once. The request carries only your
session and the time of the previous check.

**Your controls.** Turning off "Share my solves with friends" deletes every solve stored for
you and stops further uploads. Signing out ends the session. Removing a friend calls off any
open duels between you. "Delete profile" permanently deletes your profile, your sessions,
your friendships, your duels, your nudges and everything you shared. Friends are never
notified when you remove them.

Abuse-prevention counters keyed by IP address or account expire automatically within ten
minutes. Cloudflare, as the hosting provider, may process request metadata under its own
terms.

## 4. What AlgoPush does not do

- No analytics, telemetry, crash reporting or usage tracking of any kind.
- No advertising, and no advertising identifiers.
- Your data is never sold, rented, or shared with data brokers.
- Your data is never used for any purpose unrelated to syncing your submissions.
- No creditworthiness, lending, or similar assessment.
- No remote code. All executable code ships inside the extension package and is reviewed
  by the Chrome Web Store; nothing is downloaded and run at runtime.

## 5. Permissions, in plain language

- **storage** — keeps your settings, tokens and synced-problem index on your device.
- **alarms** — schedules the periodic catch-up pass that syncs submissions you made while
  the browser was closed or a tab was not open, and — only with a profile — the ten-minute
  check for friend and duel news.
- **notifications** — tells you when a sync failed, when your daily run is about to break
  (at most once a day, and you can turn it off), and — only with a profile — about friend
  requests, nudges, challenges and duel results.
- **tabs** — required to connect your judge accounts. LeetCode, AtCoder and CodeChef offer
  no third-party sign-in, so AlgoPush asks the site itself, from a tab signed in as you,
  which account the browser belongs to. It is also used to open GitHub's device-code page
  and the extension's own settings page.
- **identity** — runs the Codeforces sign-in flow in Chrome's own secure auth window.
- **Site access** to the four judges — reads your Accepted submissions and their source
  code on the sites you enabled. Judges you have not enabled are not read.
- **Site access** to GitHub — commits those solutions to your repository.

## 6. Children

AlgoPush is a developer tool and is not directed at children under 13.

## 7. Changes

If this policy changes materially, the updated version will be published at this URL with a
new "last updated" date before the change takes effect in a released version.

## 8. Contact

Questions, or a request to have something explained or corrected:
**<!-- REPLACE with the contact email you want public -->**
