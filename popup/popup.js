import { testConnection } from '../shared/github.js';
import { getEffectiveGithubToken } from '../shared/github-auth.js';
import {
    startDeviceFlow, pollForGitHubToken, fetchGitHubIdentity,
    listInstalledRepositories, getPrimaryInstallation, createRepository,
    DEFAULT_GITHUB_APP_CLIENT_ID
} from '../shared/github-oauth.js';
import { PLATFORMS, isEnabled } from '../shared/platforms.js';
import { el, setStatus, chip, dayKey, fillPad, plural, FALLBACK_AVATAR } from './ui.js';
import { initFriends, renderFriendsTab, renderProfileBlock, refreshFriendsBadge } from './friends.js';
import { initDuels, renderDuelsTab, refreshDuelsBadge, openChallenge } from './duels.js';
import { REMINDER_SETTING_KEY } from '../background/social-alerts.js';
import { computeRun, dayNumbers, dayNumber, dayString, FREEZE_MAX } from '../shared/streak.js';
import { milestonesFor } from '../shared/milestones.js';
import { resumeProfile } from '../shared/social.js';

const SCREENS = ['entry', 'github', 'lines', 'connect', 'social', 'board'];
// The optional profile step sits past the end of setup, so the rail stays full.
const RAIL_AT = { entry: 0, github: 33, lines: 66, connect: 100, social: 100, board: 0 };

const screens = {
    entry: el('screenEntry'), github: el('screenGithub'), lines: el('screenLines'),
    connect: el('screenConnect'), social: el('screenSocial'), board: el('screenBoard')
};

let current = null;

function show(name) {
    for (const key of SCREENS) screens[key].hidden = key !== name;
    const view = screens[name];
    if (current && current !== name) {
        view.classList.remove('screen--enter');
        void view.offsetWidth;
        view.classList.add('screen--enter');
    }
    current = name;
    el('railFill').style.transform = `scaleY(${RAIL_AT[name] / 100})`;
    document.body.scrollTop = 0;
}

/* ── Entry ─────────────────────────────────────────────────────────── */

el('beginBtn').addEventListener('click', () => show('github'));

/* ── Step 1 · GitHub ───────────────────────────────────────────────── */

let repoOptions = [];
let chosenRepo = '';

function renderGithub(profile) {
    const connected = Boolean(profile && profile.login);
    el('ghSetup').hidden = connected;
    el('ghConnected').hidden = !connected;

    if (connected) {
        el('ghAvatar').src = profile.avatar || FALLBACK_AVATAR;
        el('ghLogin').textContent = profile.login;

        const select = el('ghRepoSelect');
        select.replaceChildren();
        for (const repo of repoOptions) {
            const option = document.createElement('option');
            option.value = repo.fullName;
            option.textContent = repo.fullName;
            select.appendChild(option);
        }
        el('ghRepoField').hidden = repoOptions.length === 0;

        // Rendering must never silently repoint commits at another repository:
        // a saved repo that is no longer granted stays saved until the user
        // picks a replacement themselves.
        if (repoOptions.some((r) => r.fullName === chosenRepo)) {
            select.value = chosenRepo;
        } else if (!chosenRepo && repoOptions.length) {
            chosenRepo = repoOptions[0].fullName;
            select.value = chosenRepo;
            chrome.storage.local.set({ githubRepo: chosenRepo });
        } else if (chosenRepo) {
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = `Choose a repository — ${chosenRepo} is no longer granted`;
            select.insertBefore(placeholder, select.firstChild);
            select.value = '';
            setStatus('ghStatus', `AlgoPush no longer has access to ${chosenRepo}. Pick one below; syncing keeps using it until you do.`, 'error');
        }
    }

    el('ghNextBtn').disabled = !(connected && chosenRepo);
}

el('ghRepoSelect').addEventListener('change', (e) => {
    if (!e.target.value) return;
    chosenRepo = e.target.value;
    chrome.storage.local.set({ githubRepo: chosenRepo });
    el('ghNextBtn').disabled = false;
});

el('ghConnectBtn').addEventListener('click', async () => {
    const button = el('ghConnectBtn');
    const devicePanel = el('ghDevicePanel');

    button.disabled = true;
    devicePanel.hidden = true;
    setStatus('ghStatus', 'Requesting a login code from GitHub…');

    try {
        const { device_code, user_code, verification_uri, expires_in, interval } =
            await startDeviceFlow(DEFAULT_GITHUB_APP_CLIENT_ID);

        el('ghUserCode').textContent = user_code;
        el('ghVerificationLink').href = verification_uri;
        el('ghVerificationLink').textContent = verification_uri.replace(/^https?:\/\//, '');
        devicePanel.hidden = false;
        setStatus('ghStatus', 'Waiting for you to approve on GitHub…');

        chrome.tabs.create({ url: verification_uri, active: true });

        const tokens = await pollForGitHubToken(DEFAULT_GITHUB_APP_CLIENT_ID, device_code, interval, expires_in);
        const profile = await fetchGitHubIdentity(tokens.access_token);
        repoOptions = await listInstalledRepositories(tokens.access_token);

        await chrome.storage.local.set({
            githubOauthToken: tokens.access_token,
            githubOauthRefreshToken: tokens.refresh_token || null,
            githubOauthExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
            githubOauthProfile: profile,
            githubRepoOptions: repoOptions
        });

        devicePanel.hidden = true;
        renderGithub(profile);

        if (repoOptions.length === 0) {
            setStatus('ghStatus', `Connected as ${profile.login}, but the AlgoPush GitHub App is not installed on any repository yet. Install it from your GitHub App settings, then reconnect.`, 'error');
        } else {
            setStatus('ghStatus', `Connected as ${profile.login}.`, 'success');
            const back = await resumeProfile();
            if (back) {
                setStatus('ghStatus', `Welcome back, @${back.handle}. Your friends and streaks are back, and your solved history is being restored.`, 'success');
            }
        }
    } catch (error) {
        devicePanel.hidden = true;
        setStatus('ghStatus', error.message, 'error');
    } finally {
        button.disabled = false;
    }
});

el('ghDisconnectBtn').addEventListener('click', async () => {
    await chrome.storage.local.remove([
        'githubOauthToken', 'githubOauthRefreshToken', 'githubOauthExpiresAt',
        'githubOauthProfile', 'githubRepoOptions', 'githubRepo'
    ]);
    repoOptions = [];
    chosenRepo = '';
    renderGithub(null);
    setStatus('ghStatus', 'Disconnected.');
});

el('ghCreateBtn').addEventListener('click', async () => {
    const input = el('ghNewRepo');
    const name = input.value.trim();

    if (!name) {
        setStatus('ghStatus', 'Give the repository a name first.', 'error');
        return;
    }
    if (!/^[\w.-]+$/.test(name)) {
        setStatus('ghStatus', 'Repository names take letters, numbers, hyphens, underscores and dots only.', 'error');
        return;
    }

    const { githubOauthToken, githubOauthProfile } =
        await chrome.storage.local.get(['githubOauthToken', 'githubOauthProfile']);

    if (!githubOauthToken) {
        setStatus('ghStatus', 'Connect GitHub first.', 'error');
        return;
    }

    const button = el('ghCreateBtn');
    button.disabled = true;
    setStatus('ghStatus', `Creating ${name}…`);

    try {
        const installation = await getPrimaryInstallation(githubOauthToken, githubOauthProfile && githubOauthProfile.login);
        const created = await createRepository(githubOauthToken, name, installation && installation.id);

        repoOptions = [...repoOptions, {
            fullName: created.fullName,
            defaultBranch: created.defaultBranch,
            installationId: installation && installation.id
        }];
        chosenRepo = created.fullName;

        await chrome.storage.local.set({ githubRepoOptions: repoOptions, githubRepo: chosenRepo });
        input.value = '';
        renderGithub(githubOauthProfile);
        setStatus('ghStatus', `Created ${created.fullName} and pointed AlgoPush at it.`, 'success');
    } catch (error) {
        setStatus('ghStatus', error.message, 'error');
    } finally {
        button.disabled = false;
    }
});

el('ghNextBtn').addEventListener('click', () => show('lines'));

/* ── Step 2 · Lines ────────────────────────────────────────────────── */

function renderLinePicker(store) {
    const fieldset = el('linePicker');
    const legend = fieldset.querySelector('legend');
    fieldset.replaceChildren(legend);

    for (const platform of PLATFORMS) {
        const label = document.createElement('label');
        label.className = 'line';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = platform.id;
        input.checked = isEnabled(store, platform);
        input.addEventListener('change', updateLinesNext);

        const name = document.createElement('span');
        name.className = 'line-name';
        name.textContent = platform.name;

        const origin = document.createElement('span');
        origin.className = 'line-origin';
        origin.textContent = platform.origin;

        const tick = document.createElement('span');
        tick.className = 'tick';

        label.append(input, chip(platform), name, origin, tick);
        fieldset.appendChild(label);
    }
    updateLinesNext();
}

function chosenLineIds() {
    return [...el('linePicker').querySelectorAll('input:checked')].map((i) => i.value);
}

function updateLinesNext() {
    const count = chosenLineIds().length;
    el('linesNextBtn').disabled = count === 0;
    setStatus('linesStatus', count === 0 ? 'Pick at least one — AlgoPush has nothing to watch otherwise.' : '');
}

el('linesBackBtn').addEventListener('click', () => show('github'));

el('linesNextBtn').addEventListener('click', async () => {
    const chosen = new Set(chosenLineIds());
    const flags = {};
    for (const platform of PLATFORMS) flags[platform.enableKey] = chosen.has(platform.id);
    await chrome.storage.local.set(flags);
    await renderConnectList();
    show('connect');
});

/* ── Step 3 · Verify each account ──────────────────────────────────── */

const STATE_WORDS = { idle: 'Not connected', working: 'Connecting', live: 'Watching', fault: 'Needs attention' };

function setConnState(row, state) {
    row.querySelector('.mark').dataset.state = state;
    const label = row.querySelector('.conn-state');
    label.dataset.state = state;
    label.querySelector('.conn-state-word').textContent = STATE_WORDS[state];
}

async function renderConnectList() {
    const store = await chrome.storage.local.get([
        ...PLATFORMS.map((p) => p.enableKey),
        ...PLATFORMS.map((p) => p.profileKey)
    ]);

    const list = el('connectList');
    list.replaceChildren();

    for (const platform of PLATFORMS) {
        if (!isEnabled(store, platform)) continue;

        const profile = store[platform.profileKey];
        const row = document.createElement('li');
        row.className = 'conn';

        const top = document.createElement('div');
        top.className = 'conn-top';

        const body = document.createElement('div');
        body.className = 'conn-body';

        const name = document.createElement('p');
        name.className = 'conn-name';
        name.textContent = platform.name;

        const state = document.createElement('p');
        state.className = 'conn-state';
        const mark = document.createElement('span');
        mark.className = 'mark';
        const word = document.createElement('span');
        word.className = 'conn-state-word';
        state.append(mark, word);

        body.append(name, state);

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'btn btn--ghost';

        const message = document.createElement('p');
        message.className = 'conn-msg';

        top.append(chip(platform), body, action);
        row.append(top, message);
        list.appendChild(row);

        const paint = (profileNow) => {
            if (profileNow) {
                setConnState(row, 'live');
                message.textContent = `${platform.identity(profileNow)} · ${platform.detail(profileNow)}`;
                delete message.dataset.tone;
                action.textContent = 'Disconnect';
            } else {
                setConnState(row, 'idle');
                message.textContent = '';
                delete message.dataset.tone;
                action.textContent = 'Connect';
            }
        };
        paint(profile);

        action.addEventListener('click', async () => {
            const { [platform.profileKey]: existing } = await chrome.storage.local.get(platform.profileKey);

            if (existing) {
                await chrome.storage.local.remove(platform.profileKey);
                paint(null);
                return;
            }

            action.disabled = true;
            setConnState(row, 'working');
            message.textContent = `Asking ${platform.origin} who you are…`;
            delete message.dataset.tone;

            try {
                const result = await platform.login((update) => { message.textContent = update; });
                await chrome.storage.local.set({ [platform.profileKey]: result });
                paint(result);
            } catch (error) {
                setConnState(row, 'fault');
                message.textContent = error.message;
                message.dataset.tone = 'error';
                action.textContent = 'Try again';
            } finally {
                action.disabled = false;
            }
        });
    }
}

el('connectBackBtn').addEventListener('click', () => show('lines'));

// Setup is complete here: the profile step after it is optional, and closing
// the popup on it must not send anyone back through setup.
el('finishBtn').addEventListener('click', async () => {
    await chrome.storage.local.set({ onboardingComplete: true });
    await renderProfileBlock(el('socialMount'), {
        intro: false,
        onChange: (profile) => {
            el('socialDoneBtn').textContent = profile ? 'Open the board' : 'Skip — open the board';
        }
    });
    show('social');
});

/* ── Optional · Profile ────────────────────────────────────────────── */

el('socialBackBtn').addEventListener('click', () => show('connect'));

el('socialDoneBtn').addEventListener('click', async () => {
    await renderBoard();
    showTab('Stats');
    show('board');
});

/* ── Board ─────────────────────────────────────────────────────────── */

const TABS = ['Stats', 'Calendar', 'Friends', 'Duels', 'Settings'];

function showTab(name) {
    for (const other of TABS) {
        const tab = el(`tab${other}`);
        const panel = el(`panel${other}`);
        const on = other === name;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        panel.hidden = !on;
    }
    document.body.scrollTop = 0;
    if (name === 'Friends') renderFriendsTab();
    if (name === 'Duels') renderDuelsTab();
}

initFriends({ showTab, onChallenge: openChallenge });
initDuels({ showTab });

// Only an explicit false turns the evening reminder off.
chrome.storage.local.get(REMINDER_SETTING_KEY).then((store) => {
    el('reminderToggle').checked = store[REMINDER_SETTING_KEY] !== false;
});
el('reminderToggle').addEventListener('change', (event) => {
    chrome.storage.local.set({ [REMINDER_SETTING_KEY]: event.target.checked });
});

for (const [i, name] of TABS.entries()) {
    const tab = el(`tab${name}`);
    tab.addEventListener('click', () => showTab(name));
    tab.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = TABS[(i + step + TABS.length) % TABS.length];
        showTab(next);
        el(`tab${next}`).focus();
    });
}

el('openOptionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

el('alertDismiss').addEventListener('click', async () => {
    await chrome.storage.local.remove('lastError');
    el('alert').hidden = true;
});

function renderPad(days, run, frozen) {
    fillPad(el('streakPad'), days, (active) =>
        `Solving activity, last 28 days: ${active} ${active === 1 ? 'day' : 'days'} with a synced solution`
        + (frozen.size ? `, ${frozen.size} covered by a freeze. ` : '. ')
        + (run > 0 ? `Current run ${run} ${run === 1 ? 'day' : 'days'}.` : 'No run in progress.'), frozen);
}

const dayWord = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

// One line under the facts that says what the run needs next — the reason to
// solve something today, put plainly.
function runNoteText({ run, activeToday, freezes, nextFreezeIn }) {
    if (run === 0) return 'Solve one problem today to start a run. Every 7 days on a run earns a freeze that covers a missed day.';
    if (!activeToday) {
        return freezes > 0
            ? `Nothing yet today. Miss it and a freeze covers the day — ${freezes === 1 ? 'your last one' : `${freezes} left`}.`
            : 'Nothing yet today and no freeze left. One Accepted before midnight keeps the run.';
    }
    if (nextFreezeIn === null) return `Done for today. You hold the most freezes (${FREEZE_MAX}).`;
    return `Done for today. ${dayWord(nextFreezeIn)} more on the run earns ${freezes ? 'another' : 'a'} freeze.`;
}

function goalRow(name, have, target, leftText) {
    const pct = Math.max(0, Math.min(100, Math.round((have / target) * 100)));
    const bar = document.createElement('span');
    bar.style.width = `${pct}%`;
    const li = document.createElement('li');
    li.className = 'goal';
    const label = document.createElement('span');
    label.className = 'goal-name';
    label.textContent = name;
    const left = document.createElement('span');
    left.className = 'goal-left';
    left.textContent = leftText;
    const track = document.createElement('span');
    track.className = 'goal-bar';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', name);
    track.setAttribute('aria-valuenow', String(pct));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.appendChild(bar);
    li.append(label, left, track);
    return li;
}

function renderMilestones(index) {
    const { total, run, earned, next } = milestonesFor(index);
    const rows = [];
    if (next.solves) {
        rows.push(goalRow(`${next.solves.value.toLocaleString()} solves`, total, next.solves.value,
            `${next.solves.left.toLocaleString()} to go`));
    }
    if (next.run) {
        rows.push(goalRow(`${next.run.value}-day run`, run, next.run.value, `${dayWord(Math.max(0, next.run.left))} to go`));
    }
    el('goalList').replaceChildren(...rows);
    el('milestoneBlock').hidden = rows.length === 0 && earned.length === 0;

    const latest = earned.slice().sort((a, b) => (a.kind === b.kind ? b.value - a.value : 0));
    const best = ['solves', 'run'].map((kind) => latest.find((m) => m.kind === kind)).filter(Boolean);
    el('earnedNote').textContent = best.length
        ? `Reached: ${best.map((m) => m.label).join(' · ')}. ${plural(earned.length, 'milestone')} so far.`
        : '';
}

function countByPlatform(index) {
    const counts = new Map(PLATFORMS.map((p) => [p.platform, 0]));
    for (const entry of Object.values(index)) {
        if (counts.has(entry.platform)) counts.set(entry.platform, counts.get(entry.platform) + 1);
    }
    return counts;
}

function serviceRow({ mark, name, state, detail, count, dimmed }) {
    const row = document.createElement('li');
    row.className = 'srow';
    if (dimmed) row.dataset.off = '1';

    const body = document.createElement('div');
    body.className = 'srow-body';

    const title = document.createElement('p');
    title.className = 'srow-name';
    title.textContent = name;

    const line = document.createElement('p');
    line.className = 'srow-state';
    line.dataset.state = mark;

    const glyph = document.createElement('span');
    glyph.className = 'mark';
    glyph.dataset.state = mark;

    const word = document.createElement('span');
    word.textContent = state;

    line.append(glyph, word);
    if (detail) {
        const extra = document.createElement('span');
        extra.className = 'srow-detail';
        extra.textContent = detail;
        line.appendChild(extra);
    }

    body.append(title, line);
    row.appendChild(body);

    if (count !== null) {
        const tally = document.createElement('span');
        tally.className = 'srow-count';
        tally.textContent = String(count);
        row.appendChild(tally);
    }
    return row;
}

// GitHub and the four judges answer the same question — "is this working" — so
// they share one list rather than two that would have to be read together.
function renderServiceList(index, store, github) {
    const counts = countByPlatform(index);
    const list = el('serviceList');
    list.replaceChildren();

    const ghChip = document.createElement('span');
    ghChip.className = 'chip';
    ghChip.style.setProperty('--chip', 'var(--board-3)');
    ghChip.textContent = 'GH';

    const ghRow = serviceRow({
        mark: github.mark, name: 'GitHub', state: github.state,
        detail: store.githubRepo || '', count: null, dimmed: false
    });
    ghRow.insertBefore(ghChip, ghRow.firstChild);
    list.appendChild(ghRow);

    for (const platform of PLATFORMS) {
        const on = isEnabled(store, platform);
        const profile = store[platform.profileKey];

        const row = serviceRow({
            mark: !on ? 'idle' : profile ? 'live' : 'fault',
            name: platform.name,
            state: !on ? 'Off' : profile ? 'Watching' : 'Not connected',
            detail: on && profile ? platform.identity(profile) : '',
            count: counts.get(platform.platform),
            dimmed: !on
        });
        row.insertBefore(chip(platform), row.firstChild);
        list.appendChild(row);
    }
}

// The import loop lives on the settings page and would die with this panel, so
// the popup reports what each judge has banked and hands the run over.
function renderImportList(index) {
    const counts = countByPlatform(index);
    const list = el('importList');
    list.replaceChildren();

    for (const platform of PLATFORMS) {
        const row = document.createElement('li');
        row.className = 'irow';

        const name = document.createElement('span');
        name.className = 'irow-name';
        name.textContent = platform.name;

        const synced = document.createElement('span');
        synced.className = 'irow-count';
        synced.textContent = `${counts.get(platform.platform)} synced`;

        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'btn btn--ghost';
        go.textContent = 'Import';
        go.addEventListener('click', async () => {
            await chrome.storage.local.set({ pendingImport: platform.id });
            chrome.runtime.openOptionsPage();
        });

        row.append(chip(platform), name, synced, go);
        list.appendChild(row);
    }
}

function renderArrivals(history, lastSeen, canImport) {
    const list = el('arrivals');
    list.replaceChildren();

    if (history.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty';

        const line = document.createElement('p');
        line.className = 'empty-line';
        line.textContent = 'Nothing yet. Solve something — it lands here the moment the judge says Accepted.';
        empty.appendChild(line);

        // The import controls live one tab away; duplicating them here would be
        // two places to keep in step.
        if (canImport) {
            const jump = document.createElement('button');
            jump.type = 'button';
            jump.className = 'linkbtn';
            jump.textContent = 'Import what you have already solved';
            jump.addEventListener('click', () => { showTab('Settings'); el('tabSettings').focus(); });
            const wrap = document.createElement('p');
            wrap.className = 'empty-line';
            wrap.style.marginTop = '10px';
            wrap.appendChild(jump);
            empty.appendChild(wrap);
        }

        list.appendChild(empty);
        return;
    }

    for (const item of history.slice(0, 8)) {
        const platform = PLATFORMS.find((p) => p.platform === item.platform);
        const row = document.createElement('li');
        row.className = 'arrival';
        if (lastSeen && item.date > lastSeen) row.classList.add('arrival--new');

        const title = document.createElement('span');
        title.className = 'arrival-title';
        title.textContent = item.title;

        const time = document.createElement('span');
        time.className = 'arrival-time';
        time.textContent = new Date(item.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (platform) row.appendChild(chip(platform, true));
        row.append(title, time);
        list.appendChild(row);
    }
}

async function githubService(store) {
    const token = await getEffectiveGithubToken();
    const repo = store.githubRepo;

    if (!token || !repo) {
        el('repoLink').hidden = true;
        showAlert('AlgoPush has nowhere to push yet. Open Settings to connect GitHub and choose a repository.');
        return { mark: 'fault', state: 'Not configured' };
    }

    el('repoLink').hidden = false;
    el('repoLink').href = `https://github.com/${repo}`;

    const [owner, name] = repo.split('/');
    if (!owner || !name) {
        showAlert(`"${repo}" is not a valid owner/repo pair. Pick the repository again below.`);
        return { mark: 'fault', state: 'Misconfigured' };
    }

    try {
        await testConnection(token, owner, name);
        return { mark: 'live', state: 'Connected' };
    } catch (error) {
        // testConnection tells apart a missing repo, a stale token and a
        // permission gap. Collapsing those would hide the only sentence that
        // says what to do about it.
        showAlert(error.message);
        return { mark: 'fault', state: 'Check failed' };
    }
}

function fillRepoSelect(select) {
    select.replaceChildren();
    for (const repo of repoOptions) {
        const option = document.createElement('option');
        option.value = repo.fullName;
        option.textContent = repo.fullName;
        select.appendChild(option);
    }
    if (repoOptions.some((r) => r.fullName === chosenRepo)) select.value = chosenRepo;
}

function renderSettingsGithub(store) {
    const profile = store.githubOauthProfile;
    const connected = Boolean(profile && profile.login);

    el('setGhRow').hidden = !connected;
    el('setRepoField').hidden = !(connected && repoOptions.length);

    if (!connected) return;
    el('setGhAvatar').src = profile.avatar || FALLBACK_AVATAR;
    el('setGhLogin').textContent = profile.login;
    fillRepoSelect(el('setRepoSelect'));
}

el('setRepoSelect').addEventListener('change', async (event) => {
    if (!event.target.value) return;
    chosenRepo = event.target.value;
    await chrome.storage.local.set({ githubRepo: chosenRepo });
    setStatus('setGhStatus', `Pushing to ${chosenRepo}.`, 'success');
    await renderBoard();
});

el('setGhDisconnect').addEventListener('click', async () => {
    await chrome.storage.local.remove([
        'githubOauthToken', 'githubOauthRefreshToken', 'githubOauthExpiresAt',
        'githubOauthProfile', 'githubRepoOptions', 'githubRepo'
    ]);
    repoOptions = [];
    chosenRepo = '';
    renderGithub(null);
    setStatus('setGhStatus', 'Disconnected. Reconnect from the full settings page.');
    await renderBoard();
});

function showAlert(text) {
    el('alertText').textContent = text;
    el('alert').hidden = false;
}

async function renderBoard() {
    const store = await chrome.storage.local.get([
        'syncedProblemsIndex', 'syncHistory', 'lastError', 'githubRepo', 'lastSeenSync',
        'githubOauthProfile',
        ...PLATFORMS.map((p) => p.enableKey),
        ...PLATFORMS.map((p) => p.profileKey)
    ]);

    const index = store.syncedProblemsIndex || {};
    const history = store.syncHistory || [];
    const total = Object.keys(index).length;

    el('tallyCount').textContent = total.toLocaleString();
    el('tallyLabel').textContent = total === 1 ? 'solution on record' : 'solutions on record';

    const days = new Set(Object.values(index).map((entry) => entry && entry.date).filter(Boolean));
    const today = dayNumber(dayKey(new Date()));
    const streak = computeRun(dayNumbers(days), today);
    const run = streak.run;
    const frozen = new Set([...streak.frozen].map(dayString));
    const runTitle = el('runTitle');

    if (run === 0) {
        runTitle.textContent = 'Daily run';
    } else {
        runTitle.replaceChildren();
        const strong = document.createElement('b');
        strong.textContent = dayWord(run);
        runTitle.append(document.createTextNode('Daily run · '), strong);
        if (!streak.activeToday) runTitle.append(document.createTextNode(' · nothing today yet'));
    }

    renderPad(days, run, frozen);
    el('factRun').textContent = run === 0 ? '—' : dayWord(run);
    el('factFreezes').textContent = `${streak.freezes} of ${FREEZE_MAX}`;
    el('runNote').textContent = runNoteText(streak);
    renderMilestones(index);

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 6);
    const weekKey = dayKey(weekAgo);
    el('factWeek').textContent = String(
        Object.values(index).filter((entry) => entry.date && entry.date >= weekKey).length
    );

    const connectedCount = PLATFORMS.filter((p) => isEnabled(store, p) && store[p.profileKey]).length;
    renderArrivals(history, store.lastSeenSync, total === 0 && connectedCount > 0);
    renderImportList(index);
    renderSettingsGithub(store);
    renderProfileBlock(el('profileMount'));
    refreshFriendsBadge();
    refreshDuelsBadge();

    if (store.lastError) {
        showAlert(`${store.lastError.title} did not sync: ${store.lastError.message} `
            + 'Nothing was lost — re-run the import from settings to pick it up.');
    } else {
        el('alert').hidden = true;
    }

    if (history.length) await chrome.storage.local.set({ lastSeenSync: history[0].date });

    renderServiceList(index, store, await githubService(store));
    maybeRestoreIndex(store.githubRepo);
}

// An install that has not yet reconciled its index with the repository —
// fresh after a reinstall — asks the service worker to read the repo's README
// index (and the profile's shared solves) back in, then redraws once.
let restoreAsked = false;
async function maybeRestoreIndex(repo) {
    if (restoreAsked || !repo) return;
    const { indexRestoredFor } = await chrome.storage.local.get('indexRestoredFor');
    if (indexRestoredFor === repo) return;
    restoreAsked = true;
    try {
        const result = await chrome.runtime.sendMessage({ type: 'RESTORE_INDEX' });
        // The board redraws itself from the storage change.
        if (result && result.added) {
            setStatus('setGhStatus', `Restored ${plural(result.added, 'solved problem')} from ${repo}.`, 'success');
        }
    } catch {
        // The service worker retries before it next writes the index.
    }
}


// A solve that lands, or a restore that finishes, while the popup is open
// shows up without reopening it.
let redraw = null;
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.syncedProblemsIndex || current !== 'board') return;
    clearTimeout(redraw);
    redraw = setTimeout(() => renderBoard(), 400);
});

/* ── Boot ──────────────────────────────────────────────────────────── */

(async () => {
    const store = await chrome.storage.local.get([
        'onboardingComplete', 'githubOauthProfile', 'githubRepo', 'githubRepoOptions',
        ...PLATFORMS.map((p) => p.enableKey)
    ]);

    repoOptions = store.githubRepoOptions || [];
    chosenRepo = store.githubRepo || '';

    renderGithub(store.githubOauthProfile);
    renderLinePicker(store);

    // Installs that were configured before onboarding existed are already past
    // it; sending them back through setup would be a fresh chore for nothing.
    const alreadySetUp = store.onboardingComplete || Boolean(await getEffectiveGithubToken() && store.githubRepo);

    if (alreadySetUp) {
        if (!store.onboardingComplete) await chrome.storage.local.set({ onboardingComplete: true });
        await renderBoard();
        showTab('Stats');
        show('board');
    } else {
        show('entry');
    }
})();
