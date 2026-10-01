// Sample state for store captures. Realistic in shape and volume, invented in
// content: no real handles, no claim about anyone's actual usage.
const PROBLEMS = [
    ['LeetCode',   'Median of Two Sorted Arrays',   'Hard'],
    ['Codeforces', 'Book of Evil',                  'Medium'],
    ['AtCoder',    'Frog 2',                        'Medium'],
    ['LeetCode',   'Course Schedule II',            'Medium'],
    ['CodeChef',   'Chef and Subarrays',            'Medium'],
    ['Codeforces', 'Nested Segments',               'Hard'],
    ['LeetCode',   'Trapping Rain Water',           'Hard'],
    ['AtCoder',    'Knapsack 1',                    'Medium'],
    ['LeetCode',   'Longest Palindromic Substring', 'Medium'],
    ['Codeforces', 'Dijkstra?',                     'Medium'],
    ['CodeChef',   'Prime Generator',               'Easy'],
    ['LeetCode',   'Binary Tree Maximum Path Sum',  'Hard'],
    ['AtCoder',    'Grid 1',                        'Easy'],
    ['LeetCode',   'Coin Change',                   'Medium'],
    ['Codeforces', 'Ilya and Queries',              'Easy'],
    ['LeetCode',   'Word Ladder',                   'Hard'],
    ['LeetCode',   'Two Sum',                       'Easy'],
];

const dayKey = (d) => {
    const c = new Date(d);
    return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}-${String(c.getDate()).padStart(2, '0')}`;
};

export function buildSeed() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 24 of the last 28 days active, with an unbroken run ending today, so the
    // calendar reads as a habit in progress rather than a demo grid.
    const gaps = new Set([9, 10, 17, 23]);
    const activeOffsets = [];
    for (let i = 0; i < 28; i += 1) if (!gaps.has(i)) activeOffsets.push(i);

    const index = {};
    const history = [];
    let n = 0;

    for (const offset of activeOffsets) {
        const date = new Date(today);
        date.setDate(today.getDate() - offset);
        const perDay = offset % 3 === 0 ? 3 : 2;

        for (let k = 0; k < perDay; k += 1) {
            const [platform, title, difficulty] = PROBLEMS[n % PROBLEMS.length];
            const key = `${platform}:${n}`;
            index[key] = {
                title, platform, difficulty,
                tags: ['array', 'dynamic-programming'],
                link: 'https://example.com',
                folderUrl: 'https://github.com/example/algorithm-solutions',
                solutionPath: `${platform}/${difficulty}/${title}/solution.py`,
                date: dayKey(date)
            };

            const stamp = new Date(date);
            stamp.setHours(9 + ((n * 5) % 11), (n * 17) % 60, 0, 0);
            history.push({ title, platform, date: stamp.toISOString() });
            n += 1;
        }
    }

    // Pad the total to a believable back-catalogue: someone who imported their
    // history and has been solving for a while, not someone who installed today.
    for (let i = 0; i < 231; i += 1) {
        const [platform, title, difficulty] = PROBLEMS[i % PROBLEMS.length];
        const date = new Date(today);
        date.setDate(today.getDate() - 30 - (i % 210));
        index[`archive:${i}`] = {
            title, platform, difficulty, tags: [],
            link: 'https://example.com',
            folderUrl: 'https://github.com/example/algorithm-solutions',
            solutionPath: `${platform}/${difficulty}/${title}/solution.py`,
            date: dayKey(date)
        };
    }

    history.sort((a, b) => b.date.localeCompare(a.date));

    return {
        onboardingComplete: true,
        githubOauthToken: 'sample-token',
        githubRepo: 'yourname/algorithm-solutions',
        githubRepoOptions: [{ fullName: 'yourname/algorithm-solutions' }],
        githubOauthProfile: { login: 'yourname', avatar: null },
        enableLeetCode: true,
        enableCodeforces: true,
        enableAtCoder: true,
        enableCodeChef: true,
        lcProfile: { username: 'yourname', ranking: 48210 },
        cfOauthProfile: { handle: 'yourname', rating: 1487 },
        acProfile: { username: 'yourname', rating: 921 },
        ccProfile: { username: 'yourname', rating: 1703 },
        syncedProblemsIndex: index,
        syncHistory: history.slice(0, 50),
        lastSeenSync: history[3] ? history[3].date : null
    };
}
