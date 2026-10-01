import { PLATFORMS } from '../shared/platforms.js';
import { getEffectiveGithubToken } from '../shared/github-auth.js';
import {
    getSocialState, signInWithGithub, signUp, signOut, updateProfile, deleteProfile,
    listFriends, getFriend, requestFriend, acceptFriend, removeFriend, nudgeFriend, paintToolbarBadge
} from '../shared/social.js';
import { el, setStatus, chip, fillPad, plural, h, icon, avatar, safeHref, shortDate } from './ui.js';

// Profiles and friends are optional. Nothing on the board waits on them, and
// with no profile the only trace of any of this is the Friends tab's
// invitation and the Settings block that answers it.

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,22})[a-z0-9]$/i;
const HANDLE_RULE = '3–24 letters, numbers, hyphens or underscores, starting and ending with a letter or number.';
// The last list seen, so the tab paints at once while a fresh one loads.
const CACHE_KEY = 'socialFriendsCache';
// Rows of a friend's recent solves shown before "Show more"; the popup is short.
const RECENT_SHOWN = 10;

let showTab = () => {};
let onChallenge = () => {};
let friendsRequest = null;
// Rows shown on the weekly board before it folds to "…and you".
const LEADERBOARD_SHOWN = 8;

// What is waiting on an answer, from both tabs, for the toolbar count.
const waiting = { requests: 0, challenges: 0 };

export function noteWaiting(kind, count) {
    waiting[kind] = count;
    paintToolbarBadge(waiting.requests + waiting.challenges);
}
const expanded = new Set();
const details = new Map();

function stateLine(className, mark, word, detail) {
    return h('span', { class: className, 'data-state': mark },
        h('span', { class: 'mark', 'data-state': mark }),
        h('span', { text: word }),
        detail ? h('span', { class: 'prow-meta', text: detail }) : null);
}

export function initFriends({ showTab: show, onChallenge: challenge }) {
    showTab = show;
    onChallenge = challenge;

    el('friendsSetupBtn').addEventListener('click', () => {
        showTab('Settings');
        el('profileBlock').scrollIntoView({ block: 'start' });
        const first = el('profileMount').querySelector('button, input');
        if (first) first.focus();
    });

    el('addFriendForm').addEventListener('submit', onAddFriend);
    el('copyInviteBtn').addEventListener('click', onCopyInvite);
}

// Adding someone means typing their handle, so the cheapest help is handing
// them the exact text to send.
async function onCopyInvite() {
    const { profile } = await getSocialState();
    if (!profile) return;
    const text = `Keep a coding streak with me on AlgoPush — add @${profile.handle} in the Friends tab.`;
    try {
        await navigator.clipboard.writeText(text);
        setStatus('addFriendStatus', 'Invite copied. Paste it to a friend.', 'success');
    } catch {
        setStatus('addFriendStatus', `Copy failed. Send them your handle: @${profile.handle}`, 'error');
    }
}

/* ── Profile block (Settings, and the optional setup step) ──────────── */

/**
 * Draws the profile controls into `mount`: an invitation, the sign-up form,
 * or the signed-in profile. `onChange(profile | null)` hears every change.
 */
export async function renderProfileBlock(mount, { onChange = () => {}, intro = true } = {}) {
    // Where the surrounding screen already explains profiles, the block skips
    // its own explanation rather than saying it twice.
    mount.dataset.intro = intro ? '1' : '0';

    // A board refresh must not wipe a sign-up form someone is filling in.
    if (mount.dataset.editing === '1') return;

    const { signedIn, profile } = await getSocialState();
    if (signedIn && profile) {
        paintSignedIn(mount, profile, onChange);
        onChange(profile);
        return;
    }
    paintSignedOut(mount, Boolean(await getEffectiveGithubToken()), onChange);
    onChange(null);
}

function paintSignedOut(mount, hasGithub, onChange, message) {
    delete mount.dataset.editing;

    const status = h('p', { class: 'status', role: 'status' });
    const start = h('button', { class: 'btn btn--ghost btn--wide', type: 'button', disabled: !hasGithub },
        'Create a profile or sign in');

    start.addEventListener('click', async () => {
        start.disabled = true;
        setStatus(status, 'Asking GitHub who you are…');
        try {
            const result = await signInWithGithub();
            if (result.needsSignup) {
                paintSignupForm(mount, result.suggestion || {}, onChange);
                return;
            }
            paintSignedIn(mount, result.profile, onChange, result.profile.sharing
                ? `Welcome back, @${result.profile.handle}. Your friends are here and your shared history is being restored.`
                : `Welcome back, @${result.profile.handle}.`);
            onChange(result.profile);
            refreshFriendsBadge({ force: true });
        } catch (error) {
            start.disabled = false;
            setStatus(status, error.message, 'error');
        }
    });

    const note = !hasGithub
        ? 'A profile belongs to your GitHub account, so connect GitHub first.'
        : mount.dataset.intro === '0'
            ? null
            : 'Optional. With a profile, friends you add can see your daily run and what you solved — titles and links, never code. Your GitHub account is the sign-in; there is no password.';

    mount.replaceChildren(...[note && h('p', { class: 'block-note', text: note }), start, status].filter(Boolean));
    if (message) setStatus(status, message);
}

function paintSignupForm(mount, suggestion, onChange) {
    mount.dataset.editing = '1';

    const handle = h('input', {
        class: 'input', type: 'text', id: `${mount.id}Handle`, value: suggestion.handle || '',
        spellcheck: 'false', autocomplete: 'off', maxlength: '24', 'aria-describedby': `${mount.id}HandleNote`
    });
    const name = h('input', {
        class: 'input', type: 'text', id: `${mount.id}Name`, value: suggestion.displayName || '',
        autocomplete: 'off', maxlength: '40'
    });
    const share = h('input', { type: 'checkbox', checked: true });
    const status = h('p', { class: 'status', role: 'status' });
    const create = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Create profile');
    const cancel = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');

    const form = h('form', { class: 'pform', novalidate: true },
        h('div', { class: 'field' },
            h('label', { class: 'field-label', for: handle.id, text: 'Handle' }),
            handle,
            h('p', { class: 'field-note', id: `${mount.id}HandleNote`, text: `Friends add you by this. ${HANDLE_RULE}` })),
        h('div', { class: 'field' },
            h('label', { class: 'field-label', for: name.id, text: 'Display name' }),
            name),
        h('label', { class: 'line line--toggle' },
            share,
            h('span', { class: 'line-name', text: 'Share my solves with friends' }),
            h('span', { class: 'tick' })),
        status,
        h('div', { class: 'pform-actions' }, cancel, create)
    );

    cancel.addEventListener('click', async () => {
        delete mount.dataset.editing;
        paintSignedOut(mount, Boolean(await getEffectiveGithubToken()), onChange);
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const wanted = handle.value.trim().replace(/^@/, '');
        if (!HANDLE_PATTERN.test(wanted)) {
            setStatus(status, `Handles are ${HANDLE_RULE}`, 'error');
            handle.focus();
            return;
        }

        create.disabled = true;
        cancel.disabled = true;
        setStatus(status, 'Creating your profile…');
        try {
            const profile = await signUp({ handle: wanted, displayName: name.value.trim(), sharing: share.checked });
            delete mount.dataset.editing;
            paintSignedIn(mount, profile, onChange, profile.sharing
                ? `You are @${profile.handle}. Your solves are being shared in the background.`
                : `You are @${profile.handle}.`);
            onChange(profile);
            refreshFriendsBadge({ force: true });
        } catch (error) {
            create.disabled = false;
            cancel.disabled = false;
            setStatus(status, error.message, 'error');
            if (error.code === 'handle_taken' || error.code === 'bad_handle') handle.focus();
        }
    });

    mount.replaceChildren(form);
    handle.focus();
}

function paintSignedIn(mount, profile, onChange, message) {
    delete mount.dataset.editing;

    const status = h('p', { class: 'status', role: 'status' });
    const out = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Sign out');
    const share = h('input', { type: 'checkbox', checked: Boolean(profile.sharing) });
    const shareNote = h('p', { class: 'field-note' });
    const paintShareNote = (on) => {
        shareNote.textContent = on
            ? 'Friends see your daily run and solved titles. Turning this off deletes what was shared.'
            : 'Friends see your profile but none of your solves.';
    };
    paintShareNote(profile.sharing);

    const del = h('button', { class: 'linkbtn', type: 'button' }, 'Delete profile');
    const confirmRow = h('div', { class: 'confirm', hidden: true },
        h('p', { class: 'confirm-text', text: 'This deletes your profile, your friends list and everything you shared. Your GitHub repository is not touched.' }));
    const yes = h('button', { class: 'btn btn--ghost btn--danger', type: 'button' }, 'Delete profile');
    const no = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Keep it');
    confirmRow.append(h('div', { class: 'pform-actions' }, no, yes));

    out.addEventListener('click', async () => {
        out.disabled = true;
        await signOut();
        await forgetFriends();
        paintSignedOut(mount, Boolean(await getEffectiveGithubToken()), onChange, 'Signed out. Your profile is still there when you sign back in.');
        onChange(null);
    });

    share.addEventListener('change', async () => {
        share.disabled = true;
        setStatus(status, share.checked ? 'Turning sharing on…' : 'Turning sharing off…');
        try {
            const updated = await updateProfile({ sharing: share.checked });
            paintShareNote(updated.sharing);
            setStatus(status, updated.sharing
                ? 'Sharing on. Your solves are being uploaded in the background.'
                : 'Sharing off. What you had shared is deleted.', 'success');
        } catch (error) {
            share.checked = !share.checked;
            setStatus(status, error.message, 'error');
            if (error.status === 401) renderProfileBlock(mount, { onChange });
        } finally {
            share.disabled = false;
        }
    });

    del.addEventListener('click', () => {
        del.hidden = true;
        confirmRow.hidden = false;
        no.focus();
    });
    no.addEventListener('click', () => {
        confirmRow.hidden = true;
        del.hidden = false;
        del.focus();
    });
    yes.addEventListener('click', async () => {
        yes.disabled = true;
        no.disabled = true;
        try {
            await deleteProfile();
            await forgetFriends();
            paintSignedOut(mount, Boolean(await getEffectiveGithubToken()), onChange, 'Profile deleted.');
            onChange(null);
        } catch (error) {
            yes.disabled = false;
            no.disabled = false;
            setStatus(status, error.message, 'error');
        }
    });

    mount.replaceChildren(
        h('div', { class: 'idrow' },
            avatar(profile.avatarUrl),
            h('div', { class: 'idrow-text' },
                h('p', { class: 'idrow-name', text: profile.displayName }),
                h('p', { class: 'idrow-meta', text: `@${profile.handle} · friends add you by this` })),
            out),
        h('label', { class: 'line line--toggle' },
            share,
            h('span', { class: 'line-name', text: 'Share my solves with friends' }),
            h('span', { class: 'tick' })),
        shareNote,
        status,
        h('p', { class: 'pform-foot' }, del),
        confirmRow
    );
    if (message) setStatus(status, message, 'success');
}

async function forgetFriends() {
    friendsRequest = null;
    expanded.clear();
    details.clear();
    await chrome.storage.local.remove(CACHE_KEY);
    paintBadge(0);
}

/* ── Friends tab ───────────────────────────────────────────────────── */

// The board and the tab share one list request; a popup that stays open
// longer than this asks again.
const FRIENDS_FRESH_MS = 15 * 1000;
let friendsRequestedAt = 0;

export function fetchFriends({ force = false } = {}) {
    if (force || !friendsRequest || Date.now() - friendsRequestedAt > FRIENDS_FRESH_MS) {
        friendsRequestedAt = Date.now();
        friendsRequest = listFriends().then(async (data) => {
            await chrome.storage.local.set({ [CACHE_KEY]: data });
            return data;
        });
        friendsRequest.catch(() => { friendsRequest = null; });
    }
    return friendsRequest;
}

function paintBadge(count) {
    noteWaiting('requests', count);
    const badge = el('friendsBadge');
    badge.hidden = count === 0;
    badge.textContent = String(count);
    el('tabFriends').setAttribute('aria-label',
        count ? `Friends, ${plural(count, 'request')} waiting` : 'Friends');
}

/** Keeps the tab's request count current. Quiet on every failure. */
export async function refreshFriendsBadge({ force = false } = {}) {
    const { signedIn } = await getSocialState();
    if (!signedIn) {
        paintBadge(0);
        return;
    }
    const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
    if (cached) paintBadge(cached.incoming.length);
    try {
        const data = await fetchFriends({ force });
        paintBadge(data.incoming.length);
        if (!el('panelFriends').hidden) paintFriends(data);
    } catch {
        // The tab itself says what went wrong when it is opened.
    }
}

export async function renderFriendsTab({ force = false } = {}) {
    const { signedIn, profile } = await getSocialState();
    el('friendsIntro').hidden = signedIn;
    el('friendsBoard').hidden = !signedIn;
    if (!signedIn) return;

    el('myHandleNote').textContent = `You are @${profile.handle}. Friends add you by that.`;

    const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
    if (cached) paintFriends(cached);
    else setStatus('friendsStatus', 'Loading friends…');

    try {
        const data = await fetchFriends({ force });
        setStatus('friendsStatus', '');
        paintFriends(data);
    } catch (error) {
        if (error.status === 401) {
            // The session was ended elsewhere; social.js has already let go of it.
            await forgetFriends();
            renderProfileBlock(el('profileMount'));
            renderFriendsTab();
            return;
        }
        setStatus('friendsStatus', error.message, 'error');
    }
}

function paintFriends(data) {
    paintBadge(data.incoming.length);

    const incoming = el('incomingList');
    incoming.replaceChildren(...data.incoming.map(requestRow));
    el('requestsBlock').hidden = data.incoming.length === 0;

    paintLeaderboard(data);
    paintFeed(data.feed || []);

    el('friendsTitle').textContent = data.friends.length ? `Friends · ${data.friends.length}` : 'Friends';
    const list = el('friendList');
    if (data.friends.length === 0) {
        list.replaceChildren(h('li', { class: 'empty' },
            h('p', { class: 'empty-line', text: 'No friends yet. Add someone by their AlgoPush handle below.' })));
    } else {
        list.replaceChildren(...data.friends.map(friendRow));
    }

    el('outgoingList').replaceChildren(...data.outgoing.map(outgoingRow));
}

// When this week's league closes: midnight at the start of next Monday, local.
function leagueCountdown() {
    const now = new Date();
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + (8 - (end.getDay() || 7)));
    const minutes = Math.max(1, Math.round((end - now) / 60000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return `Ends in ${days}d ${hours}h`;
    if (hours > 0) return `Ends in ${hours}h ${minutes % 60}m`;
    return `Ends in ${minutes}m`;
}

const crownText = (n) => (n ? plural(n, 'crown') : '');

// The week league: you among your friends, Monday to Sunday, most solves
// wins the week's crown. A finish line every Sunday night gives everyone a
// fresh shot — a rolling window never ends, so it is never won.
function paintLeaderboard(data) {
    const block = el('leaderBlock');
    const ranked = [...data.friends, { ...data.me, you: true }].filter((p) => p.stats);
    block.hidden = data.friends.length === 0 || ranked.length < 2;
    if (block.hidden) return;

    const score = (p) => p.stats.league ?? p.stats.week;
    ranked.sort((a, b) => score(b) - score(a) || b.stats.streak - a.stats.streak
        || a.displayName.localeCompare(b.displayName));

    const rows = ranked.map((person, i) => ({ person, rank: i + 1 }));
    let shown = rows.slice(0, LEADERBOARD_SHOWN);
    const mine = rows.find((row) => row.person.you);
    if (mine && !shown.includes(mine)) shown = [...shown.slice(0, LEADERBOARD_SHOWN - 1), mine];

    el('leagueEnds').textContent = leagueCountdown();
    el('leaderList').replaceChildren(...shown.map(({ person, rank }) =>
        h('li', { class: person.you ? 'lrow lrow--you' : 'lrow' },
            h('span', { class: 'lrow-rank', text: String(rank) }),
            h('span', { class: 'lrow-name', text: person.you ? `${person.displayName} (you)` : person.displayName }),
            h('span', { class: 'lrow-crowns', text: crownText(person.crowns) }),
            h('span', { class: 'lrow-meta', text: person.stats.streak ? `${person.stats.streak}-day run` : '' }),
            h('span', { class: 'lrow-count', text: String(score(person)) }))));

    const leader = rows[0].person;
    const gap = mine ? score(leader) - score(mine.person) : 0;
    let note = '';
    if (mine && mine.rank === 1) {
        note = rows[1] && score(rows[1].person) === score(leader)
            ? 'Tied for first. One more solve takes the crown.'
            : score(leader) === 0 ? 'A fresh week. The first solve takes the lead.' : 'You hold the crown — for now.';
    } else if (mine) {
        note = `${plural(gap + 1, 'solve')} to pass ${leader.displayName} for the crown.`;
    }

    // How last week ended, from the same rows.
    const lastWeek = ranked.filter((p) => p.stats.lastWeek !== undefined);
    if (mine && lastWeek.length >= 2) {
        const best = Math.max(...lastWeek.map((p) => p.stats.lastWeek));
        if (best > 0) {
            const winners = lastWeek.filter((p) => p.stats.lastWeek === best);
            const won = winners.some((p) => p.you);
            note += won
                ? ` Last week's crown was yours (${plural(best, 'solve')}).`
                : ` Last week went to ${winners[0].displayName} with ${plural(best, 'solve')}.`;
        }
    }
    el('leaderNote').textContent = note.trim();
}

const FEED_SHOWN = 5;

function agoText(item) {
    if (!item.solvedAt) return shortDate(item.solvedOn);
    const minutes = Math.round((Date.now() - item.solvedAt) / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
    return shortDate(item.solvedOn);
}

function feedRow(item) {
    const platform = PLATFORMS.find((p) => p.platform === item.platform);
    const href = safeHref(item.link);
    return h('li', { class: 'arrival' },
        platform ? chip(platform, true) : null,
        h('span', { class: 'arrival-who', text: item.displayName }),
        href
            ? h('a', { class: 'arrival-title', href, target: '_blank', rel: 'noopener', text: item.title })
            : h('span', { class: 'arrival-title', text: item.title }),
        h('span', { class: 'arrival-time', text: agoText(item) }));
}

// What friends solved in the last couple of days: proof the others are at
// it, and a problem link one click away.
function paintFeed(feed) {
    const block = el('feedBlock');
    block.hidden = feed.length === 0;
    if (block.hidden) return;

    const list = el('feedList');
    list.replaceChildren(...feed.slice(0, FEED_SHOWN).map(feedRow));
    const rest = feed.slice(FEED_SHOWN);
    if (rest.length) {
        const more = h('button', { class: 'linkbtn', type: 'button' }, `Show ${rest.length} more`);
        const wrap = h('li', { class: 'empty' }, h('p', { class: 'pform-foot' }, more));
        more.addEventListener('click', () => {
            wrap.remove();
            list.append(...rest.map(feedRow));
        });
        list.append(wrap);
    }
}

async function afterChange(message, tone) {
    setStatus('friendsStatus', message, tone);
    try {
        paintFriends(await fetchFriends({ force: true }));
    } catch (error) {
        setStatus('friendsStatus', error.message, 'error');
    }
}

function personText(person) {
    return h('div', { class: 'prow-body' },
        h('p', { class: 'prow-name', text: person.displayName }),
        h('p', { class: 'prow-handle', text: `@${person.handle}` }));
}

function requestRow(person) {
    const accept = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Accept');
    const decline = h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Decline @${person.handle}` }, icon('close'));

    accept.addEventListener('click', async () => {
        accept.disabled = true;
        decline.disabled = true;
        try {
            await acceptFriend(person.handle);
            await afterChange(`You and @${person.handle} are friends.`, 'success');
            el('friendsTitle').focus();
        } catch (error) {
            accept.disabled = false;
            decline.disabled = false;
            setStatus('friendsStatus', error.message, 'error');
        }
    });
    decline.addEventListener('click', async () => {
        decline.disabled = true;
        accept.disabled = true;
        try {
            await removeFriend(person.handle);
            await afterChange(`Declined @${person.handle}.`);
            el('friendsTitle').focus();
        } catch (error) {
            decline.disabled = false;
            accept.disabled = false;
            setStatus('friendsStatus', error.message, 'error');
        }
    });

    return h('li', { class: 'prow prow--flat' }, avatar(person.avatarUrl, 'prow-avatar'), personText(person), accept, decline);
}

function outgoingRow(person) {
    const cancel = h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Withdraw request to @${person.handle}` }, icon('close'));
    cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        try {
            await removeFriend(person.handle);
            setStatus('addFriendStatus', `Withdrew the request to @${person.handle}.`);
            paintFriends(await fetchFriends({ force: true }));
            el('addFriendInput').focus();
        } catch (error) {
            cancel.disabled = false;
            setStatus('addFriendStatus', error.message, 'error');
        }
    });
    return h('li', { class: 'prow prow--flat prow--quiet' },
        h('span', { class: 'prow-wait', text: `Waiting on @${person.handle}` }), cancel);
}

// Shape and word first, colour third — the board's state vocabulary, applied
// to a friend's day.
function friendState(friend) {
    const stats = friend.stats;
    if (!stats) return ['idle', 'Not sharing'];
    if (stats.activeToday) return ['live', 'Solved today'];
    if (stats.streak > 0) return ['working', 'Not yet today'];
    if (stats.lastSolvedOn) return ['idle', `Last solve ${shortDate(stats.lastSolvedOn)}`];
    return ['idle', 'Nothing yet'];
}

function friendRow(friend) {
    const panelId = `friend-${friend.handle}`;
    const isOpen = expanded.has(friend.handle);
    const [mark, word] = friendState(friend);
    const run = friend.stats ? friend.stats.streak : null;
    const both = friend.together ? friend.together.streak : null;

    const head = h('button', {
        class: 'prow-head', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': panelId
    },
        avatar(friend.avatarUrl, 'prow-avatar'),
        h('span', { class: 'prow-body' },
            h('span', { class: 'prow-name', text: friend.displayName }),
            stateLine('prow-state', mark, word, `@${friend.handle}`)),
        h('span', { class: 'prow-run' },
            h('span', { class: 'prow-num', text: run === null ? '—' : String(run) }),
            h('span', { class: 'prow-unit', text: 'Run' })),
        // The streak you keep together: days you both solved.
        h('span', { class: 'prow-run prow-run--both' },
            h('span', { class: 'prow-num', text: both === null ? '—' : String(both) }),
            h('span', { class: 'prow-unit', text: 'Both' })),
        icon('down'));

    const panel = h('div', { class: 'fdetail', id: panelId, hidden: !isOpen });
    const row = h('li', { class: 'prow' }, head, panel);

    head.addEventListener('click', () => {
        const open = head.getAttribute('aria-expanded') !== 'true';
        head.setAttribute('aria-expanded', String(open));
        panel.hidden = !open;
        if (open) {
            expanded.add(friend.handle);
            loadDetail(friend, panel);
        } else {
            expanded.delete(friend.handle);
        }
    });

    if (isOpen) loadDetail(friend, panel);
    return row;
}

async function loadDetail(friend, panel) {
    const known = details.get(friend.handle);
    if (known) {
        paintDetail(friend, panel, known);
        return;
    }
    panel.replaceChildren(h('p', { class: 'status', role: 'status', text: 'Loading…' }));
    try {
        const data = await getFriend(friend.handle);
        details.set(friend.handle, data);
        paintDetail(friend, panel, data);
    } catch (error) {
        panel.replaceChildren(h('p', { class: 'status', role: 'status', 'data-tone': 'error', text: error.message }));
    }
}

function fact(label, value) {
    return h('div', {}, h('dt', { text: label }), h('dd', { text: value }));
}

function paintDetail(friend, panel, data) {
    const stats = data.stats;
    const parts = [];

    if (!stats) {
        parts.push(h('p', { class: 'empty-line', text: `@${friend.handle} is not sharing solves right now.` }));
    } else {
        parts.push(h('dl', { class: 'facts facts--four' },
            fact('Run', String(stats.streak)),
            fact('Freezes', String(stats.freezes ?? 0)),
            fact('Crowns', String((data.profile && data.profile.crowns) || 0)),
            fact('Total', stats.total.toLocaleString())));

        const pad = h('div', { class: 'pad', role: 'img' });
        const days = new Set(stats.activity.map((a) => a.day));
        const frozen = new Set(stats.frozen || []);
        fillPad(pad, days, (active) =>
            `${friend.displayName}'s activity, last 28 days: ${plural(active, 'day')} with a solve. `
            + (stats.streak > 0 ? `Current run ${plural(stats.streak, 'day')}, longest ${plural(stats.longestStreak, 'day')}.` : 'No run in progress.'),
            frozen);
        parts.push(h('section', { class: 'block' }, h('h3', { class: 'block-title', text: 'Last 28 days' }), pad));

        const judges = PLATFORMS.filter((p) => stats.platforms[p.platform]);
        if (judges.length) {
            parts.push(h('section', { class: 'block' },
                h('h3', { class: 'block-title', text: 'By judge' }),
                h('ul', { class: 'servicelist' }, ...judges.map((p) =>
                    h('li', { class: 'srow' },
                        chip(p),
                        h('div', { class: 'srow-body' }, h('p', { class: 'srow-name', text: p.name })),
                        h('span', { class: 'srow-count', text: String(stats.platforms[p.platform]) }))))));
        }

        const recent = h('section', { class: 'block' }, h('h3', { class: 'block-title', text: 'Recent solves' }));
        if (stats.recent.length === 0) {
            recent.append(h('p', { class: 'empty-line', text: 'Nothing shared yet.' }));
        } else {
            const list = h('ul', { class: 'arrivals' }, ...stats.recent.slice(0, RECENT_SHOWN).map(solveRow));
            recent.append(list);
            const rest = stats.recent.slice(RECENT_SHOWN);
            if (rest.length) {
                const more = h('button', { class: 'linkbtn', type: 'button' }, `Show ${rest.length} more`);
                more.addEventListener('click', () => {
                    const rows = rest.map(solveRow);
                    list.append(...rows);
                    more.parentElement.remove();
                    const link = rows[0].querySelector('a');
                    if (link) link.focus();
                });
                recent.append(h('p', { class: 'pform-foot' }, more));
            }
        }
        parts.push(recent);
    }

    const status = h('p', { class: 'status', role: 'status' });
    // Straight under the friend's own numbers: the part that is about you both.
    parts.splice(1, 0, togetherBlock(friend, data, status));
    const remove = h('button', { class: 'linkbtn', type: 'button' }, `Remove @${friend.handle}`);
    const yes = h('button', { class: 'btn btn--ghost btn--danger', type: 'button' }, 'Remove');
    const no = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Keep');
    const confirmRow = h('div', { class: 'confirm', hidden: true },
        h('p', { class: 'confirm-text', text: `You stop seeing each other. @${friend.handle} is not told.` }),
        h('div', { class: 'pform-actions' }, no, yes));

    remove.addEventListener('click', () => { remove.hidden = true; confirmRow.hidden = false; no.focus(); });
    no.addEventListener('click', () => { confirmRow.hidden = true; remove.hidden = false; remove.focus(); });
    yes.addEventListener('click', async () => {
        yes.disabled = true;
        no.disabled = true;
        try {
            await removeFriend(friend.handle);
            expanded.delete(friend.handle);
            details.delete(friend.handle);
            await afterChange(`Removed @${friend.handle}.`);
            el('friendsTitle').focus();
        } catch (error) {
            yes.disabled = false;
            no.disabled = false;
            setStatus(status, error.message, 'error');
        }
    });

    parts.push(h('p', { class: 'pform-foot' }, remove), confirmRow, status);
    panel.replaceChildren(...parts);
}

function togetherLine(friend, pair) {
    if (!pair) return ['idle', 'Turn on sharing in Settings to keep a streak together.'];
    if (pair.bothToday) return ['live', `You both solved today. ${plural(pair.streak, 'day')} and counting.`];
    if (pair.streak > 0) {
        if (pair.freezes > 0) {
            const miss = pair.youToday ? `${friend.displayName} misses` : 'either of you misses';
            return ['working', `${plural(pair.streak, 'day')} together. If ${miss} today, a shared freeze covers it — ${plural(pair.freezes, 'freeze')} left.`];
        }
        const who = pair.youToday ? `${friend.displayName} solves` : 'you both solve';
        return ['working', `${plural(pair.streak, 'day')} together — breaks at midnight unless ${who} today.`];
    }
    return ['idle', 'Solve on the same day to start a streak together.'];
}

// The two of you: the streak you share, how duels between you have gone,
// and the two ways to push each other.
function togetherBlock(friend, data, status) {
    const pair = data.together;
    const record = data.record || { won: 0, lost: 0, drawn: 0 };
    const [mark, word] = data.stats ? togetherLine(friend, pair) : ['idle', `${friend.displayName} is not sharing, so there is no streak to keep.`];

    const challenge = h('button', { class: 'btn btn--primary', type: 'button', disabled: !data.stats }, 'Challenge');
    challenge.addEventListener('click', () => onChallenge(friend.handle));

    const nudgeReady = Date.now() >= (data.canNudgeAt || 0);
    const nudge = h('button', { class: 'btn btn--ghost', type: 'button', disabled: !nudgeReady },
        nudgeReady ? 'Nudge' : 'Nudged');
    nudge.addEventListener('click', async () => {
        nudge.disabled = true;
        try {
            const result = await nudgeFriend(friend.handle);
            nudge.textContent = 'Nudged';
            details.set(friend.handle, { ...data, canNudgeAt: result.canNudgeAt });
            setStatus(status, `Nudged @${friend.handle}. They get a notification.`, 'success');
        } catch (error) {
            nudge.disabled = error.code === 'nudge_cooldown';
            setStatus(status, error.message, 'error');
        }
    });

    return h('section', { class: 'block' },
        h('h3', { class: 'block-title', text: 'You two' }),
        h('dl', { class: 'facts facts--three' },
            fact('Both run', pair ? String(pair.streak) : '—'),
            fact('Best', pair ? String(pair.longest) : '—'),
            fact('Duels W–L', `${record.won}–${record.lost}${record.drawn ? ` · ${record.drawn} D` : ''}`)),
        stateLine('together-state', mark, word),
        h('div', { class: 'pform-actions' }, nudge, challenge));
}

function solveRow(solve) {
    const platform = PLATFORMS.find((p) => p.platform === solve.platform);
    const href = safeHref(solve.link);
    const title = href
        ? h('a', { class: 'arrival-title', href, target: '_blank', rel: 'noopener', text: solve.title })
        : h('span', { class: 'arrival-title', text: solve.title });

    const solution = safeHref(solve.solutionUrl);
    return h('li', { class: 'arrival' },
        platform ? chip(platform, true) : null,
        title,
        h('span', { class: 'arrival-time', text: shortDate(solve.solvedOn) }),
        solution
            ? h('a', {
                class: 'iconbtn iconbtn--sm', href: solution, target: '_blank', rel: 'noopener',
                'aria-label': `${solve.title}: solution on GitHub`, title: 'Solution on GitHub'
            }, icon('out'))
            : null);
}

async function onAddFriend(event) {
    event.preventDefault();
    const input = el('addFriendInput');
    const button = el('addFriendBtn');
    const handle = input.value.trim().replace(/^@/, '');

    if (!handle) {
        setStatus('addFriendStatus', 'Type the handle they chose for their AlgoPush profile.', 'error');
        input.focus();
        return;
    }
    if (!HANDLE_PATTERN.test(handle)) {
        setStatus('addFriendStatus', `That is not a handle — handles are ${HANDLE_RULE}`, 'error');
        input.focus();
        return;
    }

    button.disabled = true;
    setStatus('addFriendStatus', `Looking for @${handle}…`);
    try {
        const result = await requestFriend(handle);
        input.value = '';
        setStatus('addFriendStatus', result.status === 'friends'
            ? `You and @${result.handle} are friends.`
            : `Asked @${result.handle}. They will see it the next time they open AlgoPush.`, 'success');
        paintFriends(await fetchFriends({ force: true }));
    } catch (error) {
        setStatus('addFriendStatus', error.message, 'error');
        input.focus();
    } finally {
        button.disabled = false;
    }
}
