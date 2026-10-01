import { getEffectiveGithubToken } from './github-auth.js';
import { localDay } from './streak.js';

// Profiles, friends and duels (see social-backend/). Entirely optional:
// nothing in the sync path waits on this, and an install that never creates
// a profile never sends it a request.
//
// Identity is the GitHub account AlgoPush already pushes to. Signing in sends
// that GitHub token to the Worker once, which asks GitHub whose it is and
// discards it; from then on the extension holds only an AlgoPush session.
//
// Like the Codeforces exchange URL, this is one shared deployment. A fork
// running its own Worker edits this constant.
export const DEFAULT_SOCIAL_API_URL = 'https://algopush-social.mynklabs.workers.dev';

const SESSION_KEY = 'socialSession';
const PROFILE_KEY = 'socialProfile';
// Set whenever the server may be missing solves the local index has, and
// cleared once a full upload lands. Uploads are upserts, so resending is safe.
export const RESYNC_KEY = 'socialNeedsResync';

const BATCH_SIZE = 500;

export class SocialError extends Error {
    constructor(message, status, code, data) {
        super(message);
        this.status = status;
        this.code = code;
        this.data = data;
    }
}

// The same local-calendar day the popup's own board counts streaks by, so a
// friend's run is judged against the viewer's today.
export { localDay };

async function call(method, path, { body, auth = true } = {}) {
    const { [SESSION_KEY]: session } = await chrome.storage.local.get(SESSION_KEY);
    if (auth && !session) throw new SocialError('Create a profile first.', 401, 'signed_out');

    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${session}`;

    let response;
    try {
        response = await fetch(`${DEFAULT_SOCIAL_API_URL}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new SocialError('Could not reach the AlgoPush friends service. Check your connection and try again.', 0, 'offline');
    }

    const raw = await response.text();
    let data;
    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        data = { error: raw };
    }

    if (!response.ok) {
        // A session the server no longer knows (signed out elsewhere, or the
        // profile was deleted) is gone for good; keeping it would only fail
        // every request after this one the same way.
        if (auth && response.status === 401) {
            await chrome.storage.local.remove([SESSION_KEY, PROFILE_KEY, RESYNC_KEY]);
        }
        throw new SocialError(data.error || `The friends service answered HTTP ${response.status}.`,
            response.status, data.code, data);
    }
    return data;
}

async function githubTokenOrThrow() {
    const token = await getEffectiveGithubToken();
    if (!token) {
        throw new SocialError('Connect GitHub first — your AlgoPush profile belongs to your GitHub account.', 0, 'no_github');
    }
    return token;
}

async function adopt({ session, profile }) {
    await chrome.storage.local.set({ [SESSION_KEY]: session, [PROFILE_KEY]: profile, [RESYNC_KEY]: profile.sharing });
    // Signing in on a fresh install is how its history comes back: the
    // service worker pulls what this profile shared into the local index
    // before uploading anything.
    if (profile.sharing) requestResync({ restore: true });
    return profile;
}

// The upload runs in the service worker, which outlives the popup that
// asked for it.
function requestResync({ restore = false } = {}) {
    chrome.runtime.sendMessage({ type: 'SOCIAL_RESYNC', restore }).catch(() => {});
}

export async function getSocialState() {
    const store = await chrome.storage.local.get([SESSION_KEY, PROFILE_KEY]);
    return { signedIn: Boolean(store[SESSION_KEY]), profile: store[PROFILE_KEY] || null };
}

/**
 * Signs in with the connected GitHub account. Resolves to
 * `{ profile }` when a profile exists, or `{ needsSignup: true, suggestion }`
 * when this GitHub account has none yet.
 */
export async function signInWithGithub() {
    const githubToken = await githubTokenOrThrow();
    try {
        return { profile: await adopt(await call('POST', '/v1/auth/github', { body: { githubToken }, auth: false })) };
    } catch (error) {
        if (error.code === 'no_account') return { needsSignup: true, suggestion: error.data.suggestion };
        throw error;
    }
}

/**
 * Right after GitHub connects: if this GitHub account already has a profile,
 * sign straight back in, so a reinstall gets its friends back without anyone
 * hunting for a button. Resolves to the profile, or null — quietly — when
 * there is none, the service is unreachable, or a session already exists.
 */
export async function resumeProfile() {
    if ((await getSocialState()).signedIn) return null;
    try {
        return (await signInWithGithub()).profile || null;
    } catch {
        return null;
    }
}

export async function signUp({ handle, displayName, sharing = true }) {
    const githubToken = await githubTokenOrThrow();
    return adopt(await call('POST', '/v1/auth/signup', {
        body: { githubToken, handle, displayName, sharing },
        auth: false
    }));
}

export async function signOut() {
    try {
        await call('POST', '/v1/auth/signout');
    } catch {
        // Signing out locally must work offline too; a session left on the
        // server can no longer be presented by anyone.
    }
    await chrome.storage.local.remove([SESSION_KEY, PROFILE_KEY, RESYNC_KEY, INBOX_SINCE_KEY]);
}

/** Every solve this profile has shared, across pages. */
export async function fetchOwnSubmissions() {
    const all = [];
    let after = '';
    do {
        const page = await call('GET', `/v1/me/submissions${after ? `?after=${encodeURIComponent(after)}` : ''}`);
        all.push(...page.submissions);
        after = page.next;
    } while (after);
    return all;
}

export async function refreshProfile() {
    const { profile } = await call('GET', '/v1/me');
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    return profile;
}

export async function updateProfile(patch) {
    const { profile } = await call('PATCH', '/v1/me', { body: patch });
    await chrome.storage.local.set({ [PROFILE_KEY]: profile, [RESYNC_KEY]: profile.sharing });
    if (patch.sharing === true) requestResync();
    return profile;
}

export async function deleteProfile() {
    await call('DELETE', '/v1/me');
    await chrome.storage.local.remove([SESSION_KEY, PROFILE_KEY, RESYNC_KEY, INBOX_SINCE_KEY]);
}

export const listFriends = () => call('GET', `/v1/friends?today=${localDay()}`);
export const getFriend = (handle) => call('GET', `/v1/friends/${encodeURIComponent(handle)}?today=${localDay()}`);
export const requestFriend = (handle) => call('POST', '/v1/friends', { body: { handle } });
export const acceptFriend = (handle) => call('POST', `/v1/friends/${encodeURIComponent(handle)}/accept`);
export const removeFriend = (handle) => call('DELETE', `/v1/friends/${encodeURIComponent(handle)}`);
export const nudgeFriend = (handle) => call('POST', `/v1/friends/${encodeURIComponent(handle)}/nudge`);

/* ── Duels ──────────────────────────────────────────────────────────── */

export const listDuels = () => call('GET', '/v1/duels');
/** `{ handle, kind: 'race' | 'sprint', hours, problem?: { key, title, link } }` */
export const createDuel = (duel) => call('POST', '/v1/duels', { body: duel });
export const acceptDuel = (id) => call('POST', `/v1/duels/${Number(id)}/accept`);
export const declineDuel = (id) => call('POST', `/v1/duels/${Number(id)}/decline`);
export const forfeitDuel = (id) => call('POST', `/v1/duels/${Number(id)}/forfeit`);
export const cancelDuel = (id) => call('DELETE', `/v1/duels/${Number(id)}`);

/* ── Inbox ──────────────────────────────────────────────────────────── */

/**
 * The toolbar count: friend requests and challenges waiting on an answer.
 * Board white on ink, like every other inverted element — red stays reserved
 * for faults.
 */
export function paintToolbarBadge(count) {
    if (!chrome.action) return;
    chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#F4F1EA' });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#15120E' });
}

// The server time of the last inbox read, so each event is reported once.
export const INBOX_SINCE_KEY = 'socialInboxSince';

/**
 * What happened since the last look: `{ events, waiting }`. Advances the
 * marker only after the caller has the events, so a crash re-reports rather
 * than drops them.
 */
export async function readInbox() {
    const { [INBOX_SINCE_KEY]: since } = await chrome.storage.local.get(INBOX_SINCE_KEY);
    const data = await call('GET', `/v1/inbox${since ? `?since=${since}` : ''}`);
    await chrome.storage.local.set({ [INBOX_SINCE_KEY]: data.now });
    return data;
}

/* ── Sharing solves ─────────────────────────────────────────────────── */

// What a friend sees of one solve: the syncedProblemsIndex record minus the
// fields that only matter to the repo (tags, solutionPath). No source code.
// `solvedAt` exists only on live syncs, and only those count in duels.
function toShared(key, entry) {
    return {
        key,
        platform: entry.platform,
        title: entry.title,
        difficulty: entry.difficulty || null,
        link: entry.link || null,
        solutionUrl: entry.folderUrl || null,
        solvedOn: entry.date,
        solvedAt: Number.isInteger(entry.solvedAt) ? entry.solvedAt : null
    };
}

async function sharingOn() {
    const store = await chrome.storage.local.get([SESSION_KEY, PROFILE_KEY]);
    return Boolean(store[SESSION_KEY] && store[PROFILE_KEY] && store[PROFILE_KEY].sharing);
}

async function upload(submissions) {
    await call('PUT', `/v1/me/submissions?today=${localDay()}`, { body: { submissions } });
}

/** Shares one just-synced solve. Never throws; a miss is retried in bulk later. */
export async function shareSubmission(key, entry) {
    if (!(await sharingOn())) return;
    try {
        await upload([toShared(key, entry)]);
    } catch (error) {
        console.warn('AlgoPush: could not share a solve with friends; it will be retried.', error);
        if (error.status !== 401) await chrome.storage.local.set({ [RESYNC_KEY]: true });
    }
}

/** Uploads the whole local index if anything may be missing. Never throws. */
export async function shareIfBehind() {
    const { [RESYNC_KEY]: behind } = await chrome.storage.local.get(RESYNC_KEY);
    if (!behind || !(await sharingOn())) return;

    const { syncedProblemsIndex = {} } = await chrome.storage.local.get('syncedProblemsIndex');
    const all = Object.entries(syncedProblemsIndex)
        .filter(([, entry]) => entry && entry.title && entry.date)
        .map(([key, entry]) => toShared(key, entry));

    try {
        for (let i = 0; i < all.length; i += BATCH_SIZE) {
            await upload(all.slice(i, i + BATCH_SIZE));
        }
        await chrome.storage.local.set({ [RESYNC_KEY]: false });
    } catch (error) {
        console.warn('AlgoPush: sharing solves with friends failed; it stays queued.', error);
    }
}

/** Marks the server as behind, for bulk imports that should not upload one by one. */
export async function markShareBehind() {
    if (await sharingOn()) await chrome.storage.local.set({ [RESYNC_KEY]: true });
}
