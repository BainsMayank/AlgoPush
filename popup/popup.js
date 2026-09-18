import { testConnection } from '../shared/github.js';
import { getEffectiveGithubToken } from '../shared/github-auth.js';
import {
    startDeviceFlow, pollForGitHubToken, fetchGitHubIdentity,
    listInstalledRepositories, getPrimaryInstallation, createRepository,
    DEFAULT_GITHUB_APP_CLIENT_ID
} from '../shared/github-oauth.js';
import { PLATFORMS, isEnabled } from '../shared/platforms.js';

const FALLBACK_AVATAR = '../images/icon128.png';
const SCREENS = ['entry', 'github', 'lines', 'connect', 'board'];
const RAIL_AT = { entry: 0, github: 33, lines: 66, connect: 100, board: 0 };

const el = (id) => document.getElementById(id);
const screens = {
    entry: el('screenEntry'), github: el('screenGithub'), lines: el('screenLines'),
    connect: el('screenConnect'), board: el('screenBoard')
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

function setStatus(id, message, tone) {
    const node = el(id);
    node.textContent = message || '';
    if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
}

function chip(platform, small) {
    const span = document.createElement('span');
    span.className = small ? 'chip chip--sm' : 'chip';
    span.style.setProperty('--chip', platform.color);
    span.textContent = platform.code;
    return span;
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

el('finishBtn').addEventListener('click', async () => {
    await chrome.storage.local.set({ onboardingComplete: true });
    await renderBoard();
    show('board');
});

/* ── Board ─────────────────────────────────────────────────────────── */

el('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

el('alertDismiss').addEventListener('click', async () => {
    await chrome.storage.local.remove('lastError');
    el('alert').hidden = true;
});

function dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function countStreak(days) {
    const cursor = new Date();
    // A run survives a day that has not finished yet: if nothing landed today,
    // the streak is measured from yesterday rather than broken on the spot.
    if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);

    let run = 0;
    while (days.has(dayKey(cursor))) {
        run += 1;
        cursor.setDate(cursor.getDate() - 1);
    }
    return run;
}

function renderPad(days, run) {
    const pad = el('streakPad');
    pad.replaceChildren();

    for (const letter of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) {
        const head = document.createElement('span');
        head.className = 'pad-day';
        head.textContent = letter;
        pad.appendChild(head);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    // Back to Monday of this week, then back three further weeks: 28 cells
    // ending on the Sunday that closes the current week.
    start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - 21);

    let active = 0;

    for (let i = 0; i < 28; i += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + i);

        const cell = document.createElement('span');
        cell.className = 'pad-cell';
        cell.textContent = String(date.getDate());

        if (date > today) cell.dataset.void = '1';
        else if (days.has(dayKey(date))) cell.dataset.on = '1';
        if (date.getTime() === today.getTime()) cell.dataset.today = '1';

        if (date <= today && days.has(dayKey(date))) active += 1;
        pad.appendChild(cell);
    }

    // role="img" collapses the 28 cells into one node, so the label has to carry
    // what a sighted reader gets from the grid.
    pad.setAttribute('aria-label',
        `Solving activity, last 28 days: ${active} ${active === 1 ? 'day' : 'days'} with a synced solution. `
        + (run > 0 ? `Current run ${run} ${run === 1 ? 'day' : 'days'}.` : 'No run in progress.'));
}

function renderTallies(index, store) {
    const counts = new Map(PLATFORMS.map((p) => [p.platform, 0]));
    for (const entry of Object.values(index)) {
        if (counts.has(entry.platform)) counts.set(entry.platform, counts.get(entry.platform) + 1);
    }

    const list = el('tallyList');
    list.replaceChildren();

    for (const platform of PLATFORMS) {
        const on = isEnabled(store, platform);
        const connected = Boolean(store[platform.profileKey]);

        const row = document.createElement('li');
        row.className = 'tallyrow';
        if (!on) row.dataset.off = '1';

        const name = document.createElement('span');
        name.className = 'tallyrow-name';
        name.textContent = platform.name;

        const state = document.createElement('span');
        state.className = 'tallyrow-state';
        if (!on) state.textContent = 'Off';
        else if (!connected) state.textContent = 'Not connected';

        const count = document.createElement('span');
        count.className = 'tallyrow-count';
        count.textContent = String(counts.get(platform.platform));

        row.append(chip(platform), name, state, count);
        list.appendChild(row);
    }
}

function renderArrivals(history, lastSeen, canImport) {
    const list = el('arrivals');
    list.replaceChildren();
    list.classList.toggle('arrivals--bare', canImport);

    if (history.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty';

        const line = document.createElement('p');
        line.className = 'empty-line';
        line.textContent = 'Nothing yet. Solve something — it lands here the moment the judge says Accepted.';
        empty.appendChild(line);

        // The backfill is the one thing that turns this board from 0 into a
        // record on day one, and it is otherwise buried in settings.
        if (canImport) {
            const importBtn = document.createElement('button');
            importBtn.type = 'button';
            importBtn.className = 'btn btn--ghost btn--wide';
            importBtn.textContent = 'Import what you have already solved';
            importBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
            empty.appendChild(importBtn);
        }

        list.appendChild(empty);
        return;
    }

    for (const item of history.slice(0, 4)) {
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

async function renderService(store) {
    const mark = el('serviceMark');
    const state = el('serviceState');

    const token = await getEffectiveGithubToken();
    const repo = store.githubRepo;

    const settle = (markState, words) => {
        mark.dataset.state = markState;
        state.textContent = words;
    };

    if (!token || !repo) {
        settle('fault', 'Not configured');
        el('repoLink').hidden = true;
        showAlert('AlgoPush has nowhere to push yet. Open settings to connect GitHub and choose a repository.');
        return;
    }

    el('repoLink').hidden = false;
    el('repoLink').href = `https://github.com/${repo}`;
    el('repoName').textContent = repo;

    const watching = PLATFORMS.filter((p) => isEnabled(store, p) && store[p.profileKey]).length;
    const [owner, name] = repo.split('/');

    if (!owner || !name) {
        settle('fault', 'Repository misconfigured');
        showAlert(`"${repo}" is not a valid owner/repo pair. Pick the repository again in settings.`);
        return;
    }

    settle('working', 'Checking');

    try {
        await testConnection(token, owner, name);
        settle('live', watching === 1 ? 'Watching 1 judge' : `Watching ${watching} judges`);
    } catch (error) {
        // testConnection tells apart a missing repo, a stale token and a
        // permission gap. Collapsing those into "unreachable" would hide the
        // only sentence that says what to do about it.
        settle('fault', 'Repository check failed');
        showAlert(error.message);
    }
}

function showAlert(text) {
    el('alertText').textContent = text;
    el('alert').hidden = false;
}

async function renderBoard() {
    const store = await chrome.storage.local.get([
        'syncedProblemsIndex', 'syncHistory', 'lastError', 'githubRepo', 'lastSeenSync',
        ...PLATFORMS.map((p) => p.enableKey),
        ...PLATFORMS.map((p) => p.profileKey)
    ]);

    const index = store.syncedProblemsIndex || {};
    const history = store.syncHistory || [];
    const total = Object.keys(index).length;

    el('tallyCount').textContent = total.toLocaleString();
    el('tallyLabel').textContent = total === 1 ? 'solution on record' : 'solutions on record';

    const days = new Set(Object.values(index).map((entry) => entry.date).filter(Boolean));
    const run = countStreak(days);
    const runTitle = el('runTitle');

    if (run === 0) {
        runTitle.textContent = 'Daily run';
    } else if (days.has(dayKey(new Date()))) {
        runTitle.innerHTML = '';
        runTitle.append(document.createTextNode('Daily run · '));
        const strong = document.createElement('b');
        strong.textContent = run === 1 ? '1 day' : `${run} days`;
        runTitle.appendChild(strong);
    } else {
        runTitle.innerHTML = '';
        const strong = document.createElement('b');
        strong.textContent = run === 1 ? '1 day' : `${run} days`;
        runTitle.append(document.createTextNode('Daily run · '), strong,
            document.createTextNode(' · nothing today yet'));
    }

    const bare = total === 0;
    el('runBlock').hidden = bare;
    el('judgeBlock').hidden = bare;
    el('arrivalsTitle').hidden = bare;

    if (!bare) {
        renderPad(days, run);
        renderTallies(index, store);
    }
    const connectedCount = PLATFORMS.filter((p) => isEnabled(store, p) && store[p.profileKey]).length;
    renderArrivals(history, store.lastSeenSync, total === 0 && connectedCount > 0);

    if (store.lastError) {
        showAlert(`${store.lastError.title} did not sync: ${store.lastError.message} `
            + 'Nothing was lost — re-run the import from settings to pick it up.');
    } else {
        el('alert').hidden = true;
    }

    if (history.length) await chrome.storage.local.set({ lastSeenSync: history[0].date });

    await renderService(store);
}

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
        show('board');
    } else {
        show('entry');
    }
})();
