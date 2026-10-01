// Turns a problem link someone pastes into the key the sync path files that
// problem under in syncedProblemsIndex ("<Platform>:<slug>"), so a race duel
// is won by the very Accepted submission that gets pushed to GitHub.
//
// The slug shapes are the ones the content scripts write:
//   LeetCode    titleSlug                   two-sum
//   Codeforces  <contestId>-<index>         1850-G
//   AtCoder     <contestId>/<taskId>        abc300/abc300_a
//   CodeChef    problem code                FLOW001

const PATTERNS = [
    {
        platform: 'LeetCode',
        re: /^https?:\/\/(?:www\.)?leetcode\.com\/problems\/([a-z0-9-]+)/i,
        build: ([slug]) => {
            const key = slug.toLowerCase();
            return {
                key,
                link: `https://leetcode.com/problems/${key}/`,
                title: key.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
            };
        }
    },
    {
        platform: 'Codeforces',
        re: /^https?:\/\/(?:www\.|m\d?\.)?codeforces\.com\/(?:contest|gym)\/(\d+)\/problem\/([A-Za-z0-9]+)/i,
        build: ([contest, index]) => codeforces(contest, index)
    },
    {
        platform: 'Codeforces',
        re: /^https?:\/\/(?:www\.|m\d?\.)?codeforces\.com\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)/i,
        build: ([contest, index]) => codeforces(contest, index)
    },
    {
        platform: 'AtCoder',
        re: /^https?:\/\/(?:www\.)?atcoder\.jp\/contests\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)/i,
        build: ([contest, task]) => ({
            key: `${contest}/${task}`,
            link: `https://atcoder.jp/contests/${contest}/tasks/${task}`,
            title: task.toUpperCase().replace(/_/g, ' ')
        })
    },
    {
        platform: 'CodeChef',
        re: /^https?:\/\/(?:www\.)?codechef\.com\/(?:[A-Za-z0-9_]+\/)?problems\/([A-Za-z0-9_]+)/i,
        build: ([code]) => ({
            key: code.toUpperCase(),
            link: `https://www.codechef.com/problems/${code.toUpperCase()}`,
            title: code.toUpperCase()
        })
    }
];

function codeforces(contest, index) {
    const upper = index.toUpperCase();
    const section = Number(contest) >= 100000 ? 'gym' : 'contest';
    return {
        key: `${contest}-${upper}`,
        link: `https://codeforces.com/${section}/${contest}/problem/${upper}`,
        title: `${contest}${upper}`
    };
}

/**
 * Returns `{ platform, key, link, title }` for a problem URL on one of the
 * four judges, or null. `key` is the full index key; `title` is a readable
 * stand-in, since the page itself is not fetched.
 */
export function parseProblemUrl(input) {
    const text = String(input || '').trim();
    for (const { platform, re, build } of PATTERNS) {
        const match = re.exec(text);
        if (!match) continue;
        const { key, link, title } = build(match.slice(1));
        return { platform, key: `${platform}:${key}`, link, title };
    }
    return null;
}
