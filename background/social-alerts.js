import { getSocialState, readInbox, localDay, paintToolbarBadge, listFriends } from '../shared/social.js';
import { computeRun, dayNumber, dayNumbers } from '../shared/streak.js';

// What reaches the user without the popup open: friend and duel news from the
// profile service, and one evening reminder when their own run is about to
// break. Both are quiet by default — a notification is only ever something
// that happened to *them*, or a run they would otherwise lose.

export const SOCIAL_ALARM = 'algopush-social-inbox';
const SOCIAL_ALARM_MINUTES = 10;

// Setting key; only an explicit `false` turns the reminder off.
export const REMINDER_SETTING_KEY = 'streakReminders';
const REMINDER_SHOWN_KEY = 'streakReminderShownOn';
// Local hour from which a run with nothing solved today is called at risk.
const REMINDER_FROM_HOUR = 20;

const ICON = 'images/icon128.png';

/**
 * Registers the periodic check once. chrome.alarms.create with an existing
 * name replaces it and restarts its period, so this checks first.
 */
export async function ensureSocialAlarm() {
    const existing = await chrome.alarms.get(SOCIAL_ALARM);
    if (existing) return;
    await chrome.alarms.create(SOCIAL_ALARM, { periodInMinutes: SOCIAL_ALARM_MINUTES, delayInMinutes: 1 });
}

let running = null;

/** Runs one check. Concurrent callers share the one in flight. Never throws. */
export function checkSocial() {
    if (!running) {
        running = runCheck()
            .catch((error) => console.warn('AlgoPush: social check failed; it runs again on the next alarm.', error))
            .finally(() => { running = null; });
    }
    return running;
}

async function runCheck() {
    await remindIfRunAtRisk();

    const { signedIn } = await getSocialState();
    if (!signedIn) {
        paintToolbarBadge(0);
        return;
    }

    let data;
    try {
        data = await readInbox();
    } catch (error) {
        // A dead session has already been cleared by social.js.
        if (error.status === 401) paintToolbarBadge(0);
        return;
    }

    for (const event of data.events) {
        const text = describe(event);
        if (text) notify(`algopush-${event.type}-${event.at}`, text);
    }
    paintToolbarBadge(data.waiting.requests + data.waiting.challenges);
}

function notify(id, { title, message }) {
    chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL(ICON),
        title,
        message
    });
}

// Opening the popup is the only useful thing a click can do. openPopup is
// refused when no browser window is focused; the notification still did its
// job by then.
export function onNotificationClicked(id) {
    chrome.notifications.clear(id);
    if (chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
}

function minutes(ms) {
    const total = Math.max(1, Math.round(ms / 60000));
    if (total < 60) return `${total} min`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function windowName(hours) {
    return hours % 24 === 0 ? `${hours / 24} ${hours === 24 ? 'day' : 'days'}` : `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

function duelLine(duel) {
    return duel.kind === 'race'
        ? `Race: first Accepted on ${duel.problem.title} within ${windowName(duel.hours)}.`
        : `Sprint: most problems solved in ${windowName(duel.hours)}.`;
}

// One sentence each, naming the person — the whole reason to send it.
function describe(event) {
    const who = event.from ? event.from.displayName : 'A friend';
    const duel = event.duel;

    switch (event.type) {
        case 'friend_request':
            return { title: `${who} wants to be friends`, message: `@${event.from.handle} · accept in the Friends tab.` };
        case 'friend_accepted':
            return { title: `You and ${who} are friends`, message: 'Your runs are side by side now. Challenge them to a duel.' };
        case 'nudge':
            return { title: `${who} nudged you`, message: 'Your run is waiting. One Accepted keeps it alive.' };
        case 'duel_invite':
            return { title: `${who} challenges you`, message: `${duelLine(duel)} Answer in the Duels tab.` };
        case 'duel_started':
            return { title: `${who} took your challenge`, message: `${duelLine(duel)} The clock is running.` };
        case 'duel_declined':
            return { title: `${who} passed on your challenge`, message: duelLine(duel) };
        case 'duel_finished':
            return finishedText(who, duel);
        default:
            return null;
    }
}

function finishedText(who, duel) {
    if (duel.forfeited === 'them') {
        return { title: `You beat ${who}`, message: `${who} forfeited the ${duel.kind}.` };
    }

    if (duel.kind === 'race') {
        const took = duel.decidedAt && duel.startedAt ? ` in ${minutes(duel.decidedAt - duel.startedAt)}` : '';
        if (duel.result === 'won') return { title: `You beat ${who}`, message: `First to solve ${duel.problem.title}${took}.` };
        if (duel.result === 'lost') return { title: `${who} won the race`, message: `They solved ${duel.problem.title}${took}. Rematch?` };
        return { title: `Race with ${who} ran out of time`, message: `Nobody solved ${duel.problem.title}. It's a draw.` };
    }

    const score = `${duel.you}–${duel.them}`;
    if (duel.result === 'won') return { title: `You beat ${who}`, message: `Sprint won ${score}.` };
    if (duel.result === 'lost') return { title: `${who} won the sprint`, message: `Lost ${score}. Rematch?` };
    return { title: `Sprint with ${who} ended level`, message: `${score}. A draw.` };
}

/* ── Milestones ────────────────────────────────────────────────────── */

export function notifyMilestone(milestone) {
    notify(`algopush-milestone-${milestone.id}`, milestone.kind === 'run'
        ? { title: `${milestone.value} days straight`, message: `A ${milestone.label}. Keep it going tomorrow.` }
        : { title: `${milestone.value.toLocaleString()} problems solved`, message: 'All of them in your repository, filed and indexed.' });
}

/* ── The evening reminder ──────────────────────────────────────────── */

// The longest streak kept with a friend that breaks tonight because *you*
// have not solved yet. A friend who has already solved makes it personal.
async function sharedRunAtRisk() {
    const { signedIn } = await getSocialState();
    if (!signedIn) return null;
    let data;
    try {
        data = await listFriends();
    } catch {
        return null;
    }
    if (!data.me.stats || data.me.stats.activeToday) return null;

    const atRisk = data.friends
        .filter((f) => f.together && f.together.streak > 0 && !f.together.bothToday && f.together.freezes === 0)
        .sort((a, b) => Number(Boolean(b.stats && b.stats.activeToday)) - Number(Boolean(a.stats && a.stats.activeToday))
            || b.together.streak - a.together.streak);
    return atRisk[0] || null;
}

async function remindIfRunAtRisk() {
    const now = new Date();
    if (now.getHours() < REMINDER_FROM_HOUR) return;

    const store = await chrome.storage.local.get(['syncedProblemsIndex', REMINDER_SETTING_KEY, REMINDER_SHOWN_KEY]);
    if (store[REMINDER_SETTING_KEY] === false) return;
    const todayKey = localDay(now);
    if (store[REMINDER_SHOWN_KEY] === todayKey) return;

    const days = dayNumbers(Object.values(store.syncedProblemsIndex || {}).map((entry) => entry && entry.date).filter(Boolean));
    const { run, activeToday, freezes } = computeRun(days, dayNumber(todayKey));
    if (activeToday) return;

    const friend = await sharedRunAtRisk();
    if (run === 0 && !friend) return;

    await chrome.storage.local.set({ [REMINDER_SHOWN_KEY]: todayKey });

    if (friend) {
        const streak = friend.together.streak;
        notify(`algopush-pair-${todayKey}`, {
            title: `Your ${streak}-day streak with ${friend.displayName} ends at midnight`,
            message: friend.stats && friend.stats.activeToday
                ? `${friend.displayName} already solved today. It's on you — one Accepted keeps it.`
                : 'Neither of you has solved today. One Accepted each keeps it going.'
        });
        return;
    }

    notify(`algopush-run-${todayKey}`, freezes > 0
        ? {
            title: `Your ${run}-day run needs a freeze tonight`,
            message: `Nothing solved today. A freeze will cover it, leaving ${freezes - 1}. One Accepted saves the freeze.`
        }
        : {
            title: `Your ${run}-day run ends at midnight`,
            message: 'Nothing solved today yet, and no freeze left. One Accepted anywhere keeps it going.'
        });
}
