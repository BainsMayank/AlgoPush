// Listing copy lives here so it can be edited without touching layout.
// Constraint from PRODUCT.md: no install counts, ratings, testimonials or
// timings — nothing on these tiles claims anything the product cannot show.

export const SCREENSHOTS = [
    {
        plate: '01',
        eyebrow: 'Automatic sync',
        headline: 'Your practice deserves a permanent record.',
        sub: 'AlgoPush commits every Accepted submission to a GitHub repository you own — '
           + 'the moment the judge accepts it. No copy-paste, no manual commits, nothing to remember.',
        shot: 'popup-stats.png',
        caption: 'The popup, after a few weeks of solving',
        facts: [
            ['Judges watched', 'LeetCode, Codeforces,<br>AtCoder, CodeChef'],
            ['Writes to', 'A repository you choose,<br>on your own account'],
            ['Your part', 'Solve the problem.<br>That&rsquo;s the whole flow.']
        ]
    },
    {
        plate: '02',
        eyebrow: 'Four judges, one repository',
        headline: 'Turn on the judges you actually use.',
        sub: 'LeetCode, Codeforces, AtCoder and CodeChef are all supported. Enable the ones you solve on and '
           + 'the rest are left alone — no sign-in asked, nothing synced.',
        shot: 'popup-lines.png',
        caption: 'Setup · step 2 of 3',
        chips: true,
        facts: [
            ['Step one', 'Connect GitHub and<br>pick a repository'],
            ['Step two', 'Choose the judges<br>you solve on'],
            ['Step three', 'Sign in to each of<br>them, once']
        ]
    },
    {
        plate: '03',
        eyebrow: 'Your repository',
        headline: 'Filed the way you’d do it by hand.',
        sub: 'Every solution lands under its platform and difficulty, beside a README naming the difficulty, '
           + 'the tags and a link back to the problem. A root index stays current as the repository grows.',
        tree: true,
        caption: 'Repository layout',
        facts: [
            ['Commit message', '“Add LeetCode - Trapping<br>Rain Water (Hard)”'],
            ['Solved again in another language', 'The superseded file is removed<br>in a commit of its own']
        ]
    },
    {
        plate: '04',
        eyebrow: 'Progress you can see',
        headline: 'See the run you’re building, day by day.',
        sub: 'A daily run, a 28-day grid and a live feed of what just landed — all counted from solutions that '
           + 'actually reached your repository, never from a number the extension invented.',
        shot: 'popup-calendar.png',
        caption: 'Calendar',
        facts: [
            ['Counted from', 'Solutions that actually reached<br>your repository'],
            ['Never counted', 'Attempts, drafts, or anything<br>that failed to push']
        ]
    },
    {
        plate: '05',
        eyebrow: 'History import',
        headline: 'Bring everything you’ve already solved.',
        sub: 'A resumable import walks your submission history on each judge and backfills the repository. '
           + 'Anything already pushed is skipped, so it is safe to stop it and pick it up later.',
        shot: 'popup-settings.png',
        caption: 'Settings · import',
        facts: [
            ['Safe to re-run', 'Anything already pushed<br>is skipped, every time'],
            ['Resumable', 'Stop it, close the tab,<br>pick it up later']
        ]
    }
];

// A directory listing, drawn in the product's own type rather than faked as a
// GitHub screenshot — it illustrates the layout without impersonating a page.
export const TREE = [
    { depth: 0, name: 'algorithm-solutions/', kind: 'root' },
    { depth: 1, name: 'README.md', note: '288 solutions indexed' },
    { depth: 1, name: 'LeetCode/', kind: 'dir', tag: 'LC' },
    { depth: 2, name: 'Hard/', kind: 'dir' },
    { depth: 3, name: 'Trapping Rain Water/', kind: 'dir' },
    { depth: 4, name: 'README.md', note: 'Difficulty, tags, link' },
    { depth: 4, name: 'solution.py', note: 'Your accepted code' },
    { depth: 2, name: 'Medium/', kind: 'dir' },
    { depth: 2, name: 'Easy/', kind: 'dir' },
    { depth: 1, name: 'Codeforces/', kind: 'dir', tag: 'CF' },
    { depth: 1, name: 'AtCoder/', kind: 'dir', tag: 'AC' },
    { depth: 1, name: 'CodeChef/', kind: 'dir', tag: 'CC' }
];
