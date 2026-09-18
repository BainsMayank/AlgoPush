import { loginWithCodeforces, DEFAULT_CF_OAUTH_CLIENT_ID, DEFAULT_CF_OAUTH_EXCHANGE_URL } from './codeforces-oauth.js';
import { loginWithLeetCode } from './leetcode-auth.js';
import { loginWithAtCoder } from './atcoder-auth.js';
import { loginWithCodeChef } from './codechef-auth.js';

// One description of each judge, shared by the popup and the options page.
// `platform` matches the string the content scripts and service worker write
// into syncHistory and syncedProblemsIndex, so counts can be grouped by it.
export const PLATFORMS = [
    {
        id: 'leetcode',
        code: 'LC',
        name: 'LeetCode',
        platform: 'LeetCode',
        color: '#FFA116',
        origin: 'leetcode.com',
        profileKey: 'lcProfile',
        enableKey: 'enableLeetCode',
        login: (onStatus) => loginWithLeetCode({ onStatus }),
        identity: (p) => p.username,
        detail: (p) => (p.ranking ? `Rank #${p.ranking.toLocaleString()}` : 'Signed in')
    },
    {
        id: 'codeforces',
        code: 'CF',
        name: 'Codeforces',
        platform: 'Codeforces',
        color: '#4A9EFF',
        origin: 'codeforces.com',
        profileKey: 'cfOauthProfile',
        enableKey: 'enableCodeforces',
        login: () => loginWithCodeforces({
            clientId: DEFAULT_CF_OAUTH_CLIENT_ID,
            exchangeUrl: DEFAULT_CF_OAUTH_EXCHANGE_URL
        }),
        identity: (p) => p.handle,
        detail: (p) => (p.rating === null || p.rating === undefined ? 'Unrated' : `Rating ${p.rating}`)
    },
    {
        id: 'atcoder',
        code: 'AC',
        name: 'AtCoder',
        platform: 'AtCoder',
        color: '#8FA3B8',
        origin: 'atcoder.jp',
        profileKey: 'acProfile',
        enableKey: 'enableAtCoder',
        login: (onStatus) => loginWithAtCoder({ onStatus }),
        identity: (p) => p.username,
        detail: (p) => (p.rating === null || p.rating === undefined ? 'Unrated' : `Rating ${p.rating}`)
    },
    {
        id: 'codechef',
        code: 'CC',
        name: 'CodeChef',
        platform: 'CodeChef',
        color: '#C4885A',
        origin: 'codechef.com',
        profileKey: 'ccProfile',
        enableKey: 'enableCodeChef',
        login: (onStatus) => loginWithCodeChef({ onStatus }),
        identity: (p) => p.username,
        detail: (p) => (p.rating === null || p.rating === undefined ? 'Unrated' : `Rating ${p.rating}`)
    }
];

export function platformById(id) {
    return PLATFORMS.find((p) => p.id === id);
}

// The service worker treats only an explicit `false` as off, so an unset flag
// means the line is in service.
export function isEnabled(store, platform) {
    return store[platform.enableKey] !== false;
}
