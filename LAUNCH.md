# AlgoPush — Chrome Web Store launch runbook

Everything needed to publish, in the order you will need it. Written to be followed
without any further research. Anything you must supply yourself is marked
**`<<FILL IN>>`**.

- **Extension ID assumed during development:** `oflhjpbehioebeaologailkkfbmleipl`
  (derived from the self-generated key pair in `.secrets/` — see §6, this probably
  changes when you publish)
- **Store assets:** `marketing/out/` — regenerate any time with `npm run store`
- **Privacy policy source:** `PRIVACY.md` in this repo — must be hosted at a public URL

---

## 1. Before you archive the project

Four things, all doable now without a developer account.

### 1.1 Short description — done

`manifest.json`'s `description` is 129 characters, under the Web Store's 132 limit:

```
Pushes every Accepted LeetCode, Codeforces, AtCoder and CodeChef solve to GitHub, and keeps streaks and duels going with friends.
```

§4.2 must match it, because the Store shows this same string in search results.

### 1.2 Bind the rate-limit KV namespace

The Codeforces exchange Worker is deployed and its 20 security tests pass, but its rate
limiter is running degraded: without a KV binding it falls back to a per-isolate counter
that a distributed caller can walk straight past.

```bash
cd oauth-backend && npx wrangler kv namespace create RATE_LIMIT_KV
```

Uncomment the `[[kv_namespaces]]` block in `oauth-backend/wrangler.toml`, paste in the id
wrangler prints, then:

```bash
cd oauth-backend && npx wrangler deploy
```

### 1.3 Host the privacy policy

You need a **public URL** before you can submit. `PRIVACY.md` is written and ready; two
blanks are marked inside it (the date and your contact email). Fill those in, then host it
by either route:

- **GitHub** — make the repo public and use the file URL:
  `https://github.com/<<YOUR-GH-USERNAME>>/AlgoPush/blob/main/PRIVACY.md`
- **GitHub Pages** — Settings → Pages → deploy from `main`, then link the rendered page.

Either is accepted. It must be reachable without a login and must stay up.

### 1.4 Commit, tag and build the zip

```bash
git add -A && git commit -m "Store-ready: popup redesign, real icons, store assets, privacy policy"
git tag v1.5.0-store-ready
./scripts/pack.sh
```

`pack.sh` writes `dist/algopush-2.0.0.zip` from an allowlist, refuses to package a
placeholder icon, and hard-fails if anything from `.secrets/` reaches staging. Keep that
zip — day 30 should be an upload, not a rebuild.

> `marketing/out/` is gitignored. The PNGs regenerate from source with `npm run store`,
> but if you want them committed so the archive is fully self-contained, delete the
> `marketing/out/` line from `.gitignore` before committing.

---

## 2. Day 30 — the order to do things in

1. Pay the **$5 one-time developer registration fee** and verify your contact email. Both
   gate publishing entirely; nothing else can proceed until they clear.
2. Go to the Developer Dashboard → **Add new item** → upload `dist/algopush-2.0.0.zip`.
3. **Immediately**, before filling anything else in: open **Package → View public key** and
   copy both the **assigned item ID** and the **public key**. Read §6 now — this is the one
   step that can silently break your Codeforces login for every user.
4. Fill in **Store listing** (§4), **Privacy practices** (§5), and **Distribution** (§7),
   pasting from this document.
5. Upload the graphic assets per the table in §3.
6. Do the §6 extension-ID fix, re-pack, and upload the corrected zip.
7. **Submit for review.** First reviews commonly take a few days and can take longer. Do
   not schedule anything around a specific date.

---

## 3. Graphic assets — which file goes in which field

All files are in `marketing/out/`. All are the exact required pixel sizes, RGB with no
alpha channel.

| Dashboard field | File | Size | Required? |
| :--- | :--- | :--- | :--- |
| Store icon | `store-icon-128.png` | 128×128 | **Yes** |
| Screenshots (up to 5) | `screenshot-1.png` … `screenshot-5.png` | 1280×800 | **At least one** |
| Small promo tile | `tile-small.png` | 440×280 | No, but required to be eligible for any curated placement — upload it |
| Marquee promo tile | `tile-marquee.png` | 1400×560 | No — only used if Google features you on the homepage |

Upload the screenshots **in numerical order**. They are written as a sequence: the pitch,
then setup, then the repository layout, then progress, then history import.

The extension's own toolbar icons (`images/icon16/32/48/128.png`) are already wired into
`manifest.json` and ship inside the zip. They are *not* uploaded through the listing form.

---

## 4. Store listing — paste-ready

### 4.1 Name
```
AlgoPush
```

### 4.2 Short description
Use the identical string you put in `manifest.json` in §1.1.

### 4.3 Detailed description
```
AlgoPush turns the problems you solve into a GitHub repository you can show someone.

Solve a problem on LeetCode, Codeforces, AtCoder or CodeChef. The moment the judge says Accepted, AlgoPush commits your solution to a repository on your own GitHub account — filed under its platform and difficulty, beside a README naming the difficulty, the tags and a link back to the problem. A root index is kept current as the repository grows.

There is no "sync now" button, because there is nothing to press.

SETUP IS THREE STEPS, ONCE
1. Connect GitHub and choose a repository, or create a new one.
2. Choose which judges you solve on.
3. Sign in to each of those judges, once.

After that AlgoPush runs quietly. The repository is up to date before you think to check it.

ALREADY SOLVED A FEW HUNDRED?
A resumable import walks your submission history on each judge and backfills the repository. Anything already pushed is skipped, so it is safe to stop it and pick it up later.

IN THE POPUP
· A count of every solution on record
· A daily run and a 28-day activity grid
· A live feed of what just landed
· An 8 pm reminder on days your run is about to break (you can turn it off)
Every number is counted from solutions that actually reached your repository.

BETTER WITH YOUR CREW — OPTIONAL
Create a profile (your GitHub account is the sign-in) and add friends by handle:
· A streak together: the days you both solved something. Miss a day and it breaks for both of you.
· A weekly board of who solved the most.
· Nudges, for a friend whose run is at risk.
· Duels. A race is the first Accepted on one problem; a sprint is the most problems solved in a day, three days or a week. Scored automatically from your synced solves, with a win–loss record.
Friends see titles, links and streaks — never your code.

YOUR ACCOUNTS, YOUR CREDENTIALS
AlgoPush never asks for a password. GitHub is connected through GitHub's own device-code flow, where you type a short code on github.com. The judges are never asked for credentials at all — AlgoPush reads only from the session you are already signed in to in your own browser. Codeforces uses its official OpenID Connect login.

PRIVACY
No analytics, no telemetry, no tracking, no ads. Without a profile, everything the extension knows stays in your browser and everything it writes goes to your repository. With one, only what friends need is shared — never source code — and deleting the profile deletes it all.

Supported judges: LeetCode · Codeforces · AtCoder · CodeChef
```

### 4.4 Category
```
Developer Tools
```

### 4.5 Language
```
English
```

---

## 5. Privacy practices tab — paste-ready

### 5.1 Single purpose description
```
AlgoPush has one purpose: to copy a user's own Accepted competitive-programming submissions into a GitHub repository that the user owns. Everything the extension does serves that single function — detecting an Accepted submission on the judges the user enabled, reading that submission's source code from the user's own signed-in session, and committing it to the user's chosen repository, organized by platform and difficulty with a generated index. Optional Friends and Duels tabs let users who create a profile keep streaks together, compare the week, and hold duels scored from those same synced solutions — the record the extension already keeps, shown only to people the user explicitly accepted.
```

> Single-purpose risk: Google reads "single purpose" strictly, and a social feature is the
> part of this listing a reviewer is most likely to question. The framing above presents it
> as a view onto the same synced-solution record, which is accurate. If a review rejects it,
> the fallback is to ship the Friends tab in a later version once the core listing is live.

### 5.2 Permission justifications

**storage**
```
Stores the user's settings, their chosen destination repository, their connected-account profiles, and an index of which problems have already been synced. That index is what prevents the same solution being committed twice. It is local to the user's device and is not transmitted to the developer — except that a user who opts in by creating a profile has their session token, a cache of their friends list and the time of their last friend-news check stored here too.
```

**alarms**
```
Schedules the periodic catch-up pass in the service worker. Submissions accepted while the browser was closed, or in a tab closed before the sync finished, are picked up on the next alarm. Without it, a solution accepted at the wrong moment would never be committed, which would break the extension's core promise that the user does not have to do anything. A second alarm, every ten minutes, checks the time for the optional evening streak reminder and, for users with a profile, fetches friend and duel news.
```

**notifications**
```
Tells the user when a sync failed and why; once a day at most, when their daily solving run is about to break (they can turn this off); and, only for users who created a profile, about friend requests, nudges, duel challenges and duel results. The extension is designed to run without being watched, so anything that needs the user must reach them without the popup open.
```

**tabs**
```
Required to establish which judge account belongs to the user. LeetCode, AtCoder and CodeChef publish no third-party sign-in mechanism of any kind, so instead of asking for a password the extension asks the site itself, from a tab already signed in as the user, which account the browser belongs to, and reads back the handle. It is also used to open GitHub's device-code page during setup and the extension's own options page. The extension does not enumerate, read or monitor tabs outside these flows.
```

**identity**
```
Runs the Codeforces sign-in through chrome.identity.launchWebAuthFlow, so that Codeforces' official OpenID Connect login happens in Chrome's own authentication window rather than in a page the extension controls. This is the only use of the permission.
```

**Host permission — leetcode.com, codeforces.com, atcoder.jp, codechef.com**
```
Content scripts detect when a submission is Accepted on the judges the user has explicitly enabled, and read that submission's source code from the user's own signed-in session so it can be committed to their repository. Judges the user has not enabled are not read. No credentials are sent by the extension; these requests carry only the cookies the browser already has.
```

**Host permission — kenkoooo.com**
```
AtCoder publishes no API for problem metadata or difficulty ratings. The community-run AtCoder Problems dataset at kenkoooo.com supplies problem titles, difficulty estimates and the user's own submission list, which are needed to file AtCoder solutions by difficulty. Requested only when the user has enabled AtCoder. Submission source code is never read from this service — that always comes from atcoder.jp itself.
```

**Host permission — api.github.com, github.com**
```
Commits the user's solutions to the repository they selected, creates a repository when they ask for one, lists their repositories during setup, and maintains the root README index. This is the extension's core function and the entire reason it exists.
```

### 5.3 Remote code
```
No, I am not using remote code.
```
All executable code ships inside the package. Nothing is fetched and evaluated at runtime.

### 5.4 Data usage — what to tick

Tick these two:

- **Authentication information** — the extension stores a GitHub OAuth access token and
  refresh token locally in order to commit on the user's behalf.
- **Website content** — solution source code is read from the judge's page and committed to
  the user's repository.

- **Personally identifiable information** — only for users who create an optional profile:
  the display name they choose (which may be a real name), their handle and GitHub username
  are stored on the AlgoPush profile service and shown to friends they accept.

Leave every other category unticked: no health, financial, location, web history, personal
communications, or user-activity data is touched.

> Before profiles existed this box was a judgment call (public usernames only, kept local).
> A user-chosen display name stored on a server is plainly in scope, so tick it. The
> "transfer" certifications below still hold: profile data goes only to friends the user
> accepted, which is the feature's purpose.

Then certify all three:

- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

### 5.5 Privacy policy URL
```
<<PASTE THE URL YOU SET UP IN §1.3>>
```

---

## 6. The extension ID problem — read this before submitting

**What is going on.** `manifest.json` contains a `key` field. The ID
`oflhjpbehioebeaologailkkfbmleipl` is derived from it, and that key came from a key pair
you generated locally — it matches `.secrets/algopush-extension-key.pub.b64`. Your
Codeforces OAuth app has `https://oflhjpbehioebeaologailkkfbmleipl.chromiumapp.org/`
registered as its redirect URI, and `oauth-backend/src/index.js` hardcodes both that
redirect URI and the matching `chrome-extension://` allowed origin.

**The risk.** The Chrome Web Store generates its own key pair when you first create an item
and derives the published ID from that. A `key` field in an uploaded manifest does not
control the published ID. The documented way to keep dev and production in sync runs the
other direction: you publish, read the public key the Store assigns, and paste *that* into
your manifest.

If that is what happens, your published extension gets a different ID,
`launchWebAuthFlow` returns a redirect URI Codeforces does not recognise, the Worker's
origin allowlist rejects the request, and **"Connect Codeforces Account" is broken for
every user from day one.** GitHub is unaffected — it uses device flow, which has no ID
dependency. LeetCode, AtCoder and CodeChef are unaffected for the same reason.

**What to do at step 3 of §2.** Compare the item ID the dashboard assigned against
`oflhjpbehioebeaologailkkfbmleipl`.

*If they match* — nothing to do. Carry on.

*If they differ* — do all four, then re-pack and re-upload:

1. **Codeforces** — edit your OAuth app's registered redirect URI to
   `https://<<ASSIGNED-ID>>.chromiumapp.org/`.
2. **`oauth-backend/src/index.js`** — update `DEFAULT_REDIRECT_URI` (line ~24) and
   `DEFAULT_ALLOWED_ORIGINS` (line ~37) to the assigned ID, then
   `cd oauth-backend && npx wrangler deploy`.
3. **`manifest.json`** — replace the `key` value with the public key the dashboard shows,
   so your local unpacked build keeps the same ID as production.
4. **`oauth-backend/test/exchange.test.mjs`** and **`oauth-backend/README.md`** — both
   name the old ID. Update them and re-run `npm test` in `oauth-backend/`; all 20 tests
   should still pass.

To find every reference in one go:

```bash
grep -rn oflhjpbehioebeaologailkkfbmleipl . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.wrangler
```

Then `./scripts/pack.sh` and upload the new zip before submitting.

> The comments in `scripts/pack.sh` and `README.md` currently assert the opposite — that
> keeping `key` preserves the ID. If the dashboard proves them right, correct this section.
> If it proves them wrong, correct those two files.

---

## 7. Distribution tab

- **Visibility:** Public (or Unlisted first, if you want to install from the store yourself
  and test the real published build before anyone can find it — recommended, given §6).
- **Regions:** All, unless you have a reason otherwise.
- **Pricing:** Free.

If you go Unlisted first: install it, connect all four judges, confirm Codeforces works,
then flip to Public. That converts §6 from a live outage into a ten-minute fix.

---

## 8. Post-publish smoke test

In a clean Chrome profile, install from the store listing and check:

- [ ] Toolbar icon renders correctly at small size
- [ ] Onboarding runs: GitHub device code → repository choice → judge picker → sign-ins
- [ ] **Connect Codeforces Account completes** (the §6 failure mode)
- [ ] Connect LeetCode, AtCoder, CodeChef each resolve the right handle
- [ ] Solve something easy on LeetCode → confirm the commit lands, correctly filed
- [ ] The problem README and the root index are both written
- [ ] A notification fires on success
- [ ] Run a history import, stop it midway, restart it, confirm nothing is duplicated

---

## 9. Loose ends, not blockers

- **No LICENSE file.** Not a Store requirement, but if the repo is public, without one
  nobody may legally use or contribute to it. A `LICENSE` file has been added with MIT
  terms — **check the name and year, and replace the whole file if you want different
  terms.** This is your call, not a default you should accept unexamined.
- **`README.md` and `scripts/pack.sh`** both contain the extension-ID claim discussed in
  §6. Correct them once you know the answer.
- **Version bumps.** Each new upload needs a higher `manifest.json` `version`. The Store
  rejects a re-upload at the same version.
