import { PLATFORMS } from '../shared/platforms.js';
import {
    getSocialState, listDuels, createDuel, acceptDuel, declineDuel, cancelDuel, forfeitDuel
} from '../shared/social.js';
import { parseProblemUrl } from '../shared/problem-url.js';
import { el, setStatus, plural, h, icon, avatar, safeHref, chip } from './ui.js';
import { fetchFriends, noteWaiting } from './friends.js';

// Duels: a race is the first Accepted on one problem; a sprint is the most
// problems solved before time runs out. Both are scored by the server from
// the same live syncs that land in the repo, so there is nothing to report
// by hand — solve, and the score moves.

const HOURS = { race: [1, 24, 72], sprint: [24, 72, 168] };
const DEFAULT_HOURS = { race: 24, sprint: 72 };
const DUELS_FRESH_MS = 15 * 1000;
const RESULTS_SHOWN = 8;

let showTab = () => {};
let duelsRequest = null;
let duelsRequestedAt = 0;
// A friend chosen from elsewhere (a friend's Challenge button), applied once
// the select has options to choose from.
let pendingOpponent = null;

function fetchDuels({ force = false } = {}) {
    if (force || !duelsRequest || Date.now() - duelsRequestedAt > DUELS_FRESH_MS) {
        duelsRequestedAt = Date.now();
        duelsRequest = listDuels();
        duelsRequest.catch(() => { duelsRequest = null; });
    }
    return duelsRequest;
}

function windowName(hours) {
    if (hours % 24 === 0) return plural(hours / 24, 'day');
    return plural(hours, 'hour');
}

function timeLeft(ms) {
    if (ms <= 0) return 'time is up';
    const minutes = Math.ceil(ms / 60000);
    if (minutes < 60) return `${minutes} min left`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h ${minutes % 60 ? `${minutes % 60} min ` : ''}left`;
    return `${Math.floor(hours / 24)} d ${hours % 24} h left`;
}

function took(duel) {
    if (!duel.decidedAt || !duel.startedAt) return '';
    const minutes = Math.max(1, Math.round((duel.decidedAt - duel.startedAt) / 60000));
    return minutes < 60 ? ` in ${minutes} min` : ` in ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function describe(duel) {
    return duel.kind === 'race'
        ? `Race · first Accepted within ${windowName(duel.hours)}`
        : `Sprint · most solves in ${windowName(duel.hours)}`;
}

function problemLink(duel) {
    if (!duel.problem) return null;
    const platform = PLATFORMS.find((p) => duel.problem.key && duel.problem.key.startsWith(`${p.platform}:`));
    const href = safeHref(duel.problem.link);
    return h('span', { class: 'drow-problem' },
        platform ? chip(platform, true) : null,
        href
            ? h('a', { href, target: '_blank', rel: 'noopener', text: duel.problem.title })
            : h('span', { text: duel.problem.title }));
}

function markLine(mark, word, detail) {
    return h('p', { class: 'drow-state', 'data-state': mark },
        h('span', { class: 'mark', 'data-state': mark }),
        h('span', { text: word }),
        detail ? h('span', { class: 'prow-meta', text: detail }) : null);
}

/* ── Setup ─────────────────────────────────────────────────────────── */

export function initDuels({ showTab: show }) {
    showTab = show;

    el('duelsSetupBtn').addEventListener('click', () => {
        showTab('Settings');
        el('profileBlock').scrollIntoView({ block: 'start' });
        const first = el('profileMount').querySelector('button, input');
        if (first) first.focus();
    });

    for (const radio of document.querySelectorAll('input[name="duelKind"]')) {
        radio.addEventListener('change', paintKind);
    }
    el('duelProblem').addEventListener('input', previewProblem);
    el('duelForm').addEventListener('submit', onChallenge);
    paintKind();
}

function chosenKind() {
    const checked = document.querySelector('input[name="duelKind"]:checked');
    return checked ? checked.value : 'sprint';
}

function paintKind() {
    const kind = chosenKind();
    el('duelProblemField').hidden = kind !== 'race';

    const select = el('duelHours');
    const previous = Number(select.value);
    select.replaceChildren(...HOURS[kind].map((hours) =>
        h('option', { value: String(hours), text: windowName(hours) })));
    select.value = String(HOURS[kind].includes(previous) ? previous : DEFAULT_HOURS[kind]);
}

function previewProblem() {
    const text = el('duelProblem').value.trim();
    const note = el('duelProblemNote');
    if (!text) {
        setStatus(note, 'Paste a problem link from LeetCode, Codeforces, AtCoder or CodeChef.');
        return null;
    }
    const problem = parseProblemUrl(text);
    if (!problem) {
        setStatus(note, 'That is not a problem link AlgoPush can follow.', 'error');
        return null;
    }
    setStatus(note, `${problem.platform} · ${problem.title}. Neither of you may have solved it before.`);
    return problem;
}

/**
 * Opens the Duels tab with `handle` chosen as the opponent — the Challenge
 * button on a friend's card lands here.
 */
export function openChallenge(handle) {
    pendingOpponent = handle;
    showTab('Duels');
}

/* ── Rendering ─────────────────────────────────────────────────────── */

function paintTabBadge(count) {
    noteWaiting('challenges', count);
    const badge = el('duelsBadge');
    badge.hidden = count === 0;
    badge.textContent = String(count);
    el('tabDuels').setAttribute('aria-label', count ? `Duels, ${plural(count, 'challenge')} waiting` : 'Duels');
}

const invitesIn = (data) => data.duels.filter((d) => d.status === 'pending' && d.role === 'opponent');

/** Keeps the tab's challenge count current. Quiet on every failure. */
export async function refreshDuelsBadge() {
    const { signedIn } = await getSocialState();
    if (!signedIn) {
        paintTabBadge(0);
        return;
    }
    try {
        const data = await fetchDuels();
        paintTabBadge(invitesIn(data).length);
        if (!el('panelDuels').hidden) paintDuels(data);
    } catch {
        // The tab says what went wrong when it is opened.
    }
}

export async function renderDuelsTab({ force = false } = {}) {
    const { signedIn } = await getSocialState();
    el('duelsIntro').hidden = signedIn;
    el('duelsBoard').hidden = !signedIn;
    if (!signedIn) return;

    if (!duelsRequest) setStatus('duelsStatus', 'Loading duels…');
    try {
        const [data, friends] = await Promise.all([fetchDuels({ force }), fetchFriends()]);
        setStatus('duelsStatus', '');
        paintOpponents(friends);
        paintDuels(data);
    } catch (error) {
        setStatus('duelsStatus', error.message, 'error');
    }
}

function paintOpponents(friends) {
    const select = el('duelFriend');
    const previous = pendingOpponent || select.value;
    const eligible = friends.friends.filter((f) => f.stats);

    select.replaceChildren(...eligible.map((f) =>
        h('option', { value: f.handle, text: `${f.displayName} (@${f.handle})` })));
    el('duelFormFields').hidden = eligible.length === 0;
    el('duelNoFriends').hidden = eligible.length > 0;
    el('duelNoFriends').textContent = friends.friends.length
        ? 'None of your friends are sharing solves right now, so there is nothing to score a duel from.'
        : 'Add a friend first — the Friends tab has the box for their handle.';

    if (previous && eligible.some((f) => f.handle === previous)) select.value = previous;
    if (pendingOpponent) {
        pendingOpponent = null;
        el('duelNew').scrollIntoView({ block: 'start' });
        select.focus();
    }
}

function paintDuels(data) {
    const { record, duels } = data;
    el('duelWon').textContent = String(record.won);
    el('duelLost').textContent = String(record.lost);
    el('duelDrawn').textContent = String(record.drawn);

    const invites = invitesIn(data);
    paintTabBadge(invites.length);
    el('invitesBlock').hidden = invites.length === 0;
    el('inviteList').replaceChildren(...invites.map(inviteRow));

    const active = duels.filter((d) => d.status === 'active');
    el('activeBlock').hidden = active.length === 0;
    el('activeList').replaceChildren(...active.map(activeRow));

    const waitingOn = duels.filter((d) => d.status === 'pending' && d.role === 'challenger');
    el('waitingList').replaceChildren(...waitingOn.map(waitingRow));

    const finished = duels.filter((d) => d.status === 'finished').slice(0, RESULTS_SHOWN);
    el('resultsBlock').hidden = finished.length === 0;
    el('resultList').replaceChildren(...finished.map(resultRow));
}

async function afterChange(message, tone) {
    setStatus('duelsStatus', message, tone);
    try {
        paintDuels(await fetchDuels({ force: true }));
    } catch (error) {
        setStatus('duelsStatus', error.message, 'error');
    }
}

function inviteRow(duel) {
    const accept = h('button', { class: 'btn btn--primary', type: 'button' }, 'Accept');
    const decline = h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Decline ${duel.opponent.displayName}'s challenge` }, icon('close'));

    accept.addEventListener('click', async () => {
        accept.disabled = true;
        decline.disabled = true;
        try {
            await acceptDuel(duel.id);
            await afterChange(`On. The clock is running — ${timeLeft(duel.hours * 3600 * 1000)}.`, 'success');
            el('activeTitle').focus();
        } catch (error) {
            await afterChange(error.message, 'error');
        }
    });
    decline.addEventListener('click', async () => {
        decline.disabled = true;
        accept.disabled = true;
        try {
            await declineDuel(duel.id);
            await afterChange(`Passed on ${duel.opponent.displayName}'s challenge.`);
        } catch (error) {
            await afterChange(error.message, 'error');
        }
    });

    return h('li', { class: 'drow' },
        avatar(duel.opponent.avatarUrl, 'prow-avatar'),
        h('div', { class: 'drow-body' },
            h('p', { class: 'drow-title', text: `${duel.opponent.displayName} challenges you` }),
            h('p', { class: 'drow-meta', text: describe(duel) }),
            problemLink(duel)),
        accept, decline);
}

function activeRow(duel) {
    const left = timeLeft(duel.endsAt - Date.now());
    let state;
    let score = null;

    if (duel.kind === 'race') {
        state = markLine('working', 'Unsolved', left);
    } else {
        const word = duel.you > duel.them ? 'Leading' : duel.you < duel.them ? 'Behind' : 'Level';
        const mark = duel.you > duel.them ? 'live' : duel.you < duel.them ? 'working' : 'idle';
        state = markLine(mark, word, left);
        score = h('span', { class: 'drow-score', 'aria-label': `You ${duel.you}, ${duel.opponent.displayName} ${duel.them}` },
            h('span', { class: 'prow-num', text: `${duel.you}–${duel.them}` }),
            h('span', { class: 'prow-unit', text: 'You–them' }));
    }

    const status = h('p', { class: 'status', role: 'status' });
    const forfeit = h('button', { class: 'linkbtn', type: 'button' }, 'Forfeit');
    const yes = h('button', { class: 'btn btn--ghost btn--danger', type: 'button' }, 'Forfeit');
    const no = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Keep going');
    const confirmRow = h('div', { class: 'confirm', hidden: true },
        h('p', { class: 'confirm-text', text: `${duel.opponent.displayName} takes the win and it goes on your record.` }),
        h('div', { class: 'pform-actions' }, no, yes));

    forfeit.addEventListener('click', () => { forfeit.hidden = true; confirmRow.hidden = false; no.focus(); });
    no.addEventListener('click', () => { confirmRow.hidden = true; forfeit.hidden = false; forfeit.focus(); });
    yes.addEventListener('click', async () => {
        yes.disabled = true;
        no.disabled = true;
        try {
            await forfeitDuel(duel.id);
            await afterChange(`Forfeited to ${duel.opponent.displayName}.`);
        } catch (error) {
            yes.disabled = false;
            no.disabled = false;
            setStatus(status, error.message, 'error');
        }
    });

    return h('li', { class: 'drow drow--stack' },
        h('div', { class: 'drow-top' },
            avatar(duel.opponent.avatarUrl, 'prow-avatar'),
            h('div', { class: 'drow-body' },
                h('p', { class: 'drow-title', text: `${duel.kind === 'race' ? 'Race' : 'Sprint'} vs ${duel.opponent.displayName}` }),
                problemLink(duel),
                state),
            score),
        h('p', { class: 'drow-foot' }, forfeit),
        confirmRow,
        status);
}

function waitingRow(duel) {
    const cancel = h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Withdraw the challenge to ${duel.opponent.displayName}` }, icon('close'));
    cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        try {
            await cancelDuel(duel.id);
            await afterChange('Challenge withdrawn.');
        } catch (error) {
            await afterChange(error.message, 'error');
        }
    });
    const lapses = duel.expiresAt ? ` · lapses in ${timeLeft(duel.expiresAt - Date.now()).replace(' left', '')}` : '';
    return h('li', { class: 'prow prow--flat prow--quiet' },
        h('span', { class: 'prow-wait', text: `Waiting on ${duel.opponent.displayName} · ${duel.kind} ${windowName(duel.hours)}${lapses}` }),
        cancel);
}

const RESULT = {
    won: ['live', 'Won'],
    lost: ['idle', 'Lost'],
    draw: ['working', 'Draw']
};

function resultRow(duel) {
    const [mark, word] = RESULT[duel.result] || RESULT.draw;
    let detail;
    if (duel.forfeited) {
        detail = duel.forfeited === 'you' ? 'you forfeited' : 'they forfeited';
    } else if (duel.kind === 'race') {
        detail = duel.result === 'draw' ? 'nobody solved it' : `${duel.result === 'won' ? 'you' : 'they'} solved it${took(duel)}`;
    } else {
        detail = `${duel.you}–${duel.them}`;
    }

    const rematch = h('button', { class: 'linkbtn', type: 'button' }, 'Rematch');
    rematch.addEventListener('click', () => {
        pendingOpponent = duel.opponent.handle;
        const radio = document.querySelector(`input[name="duelKind"][value="${duel.kind}"]`);
        if (radio) radio.checked = true;
        paintKind();
        el('duelHours').value = String(duel.hours);
        renderDuelsTab();
        if (duel.kind === 'race') setTimeout(() => el('duelProblem').focus(), 0);
    });

    return h('li', { class: 'drow' },
        h('div', { class: 'drow-body' },
            h('p', { class: 'drow-title', text: `${duel.kind === 'race' ? 'Race' : 'Sprint'} vs ${duel.opponent.displayName}` }),
            duel.problem ? problemLink(duel) : null,
            markLine(mark, word, detail)),
        rematch);
}

/* ── New challenge ─────────────────────────────────────────────────── */

async function onChallenge(event) {
    event.preventDefault();
    const handle = el('duelFriend').value;
    const kind = chosenKind();
    const hours = Number(el('duelHours').value);

    if (!handle) {
        setStatus('duelFormStatus', 'Choose who to challenge.', 'error');
        return;
    }

    let problem;
    if (kind === 'race') {
        problem = previewProblem();
        if (!problem) {
            setStatus('duelFormStatus', 'A race needs a problem link.', 'error');
            el('duelProblem').focus();
            return;
        }
    }

    const button = el('duelSendBtn');
    button.disabled = true;
    setStatus('duelFormStatus', 'Sending the challenge…');
    try {
        const { duel } = await createDuel({
            handle,
            kind,
            hours,
            problem: problem && { key: problem.key, title: problem.title, link: problem.link }
        });
        el('duelProblem').value = '';
        previewProblem();
        setStatus('duelFormStatus',
            `Sent. ${duel.opponent.displayName} has 48 hours to accept; the clock starts when they do.`, 'success');
        paintDuels(await fetchDuels({ force: true }));
    } catch (error) {
        setStatus('duelFormStatus', error.message, 'error');
    } finally {
        button.disabled = false;
    }
}
