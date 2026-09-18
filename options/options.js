import { testConnection, resolveBranch } from '../shared/github.js';
import { loginWithCodeforces, DEFAULT_CF_OAUTH_CLIENT_ID, DEFAULT_CF_OAUTH_EXCHANGE_URL } from '../shared/codeforces-oauth.js';
import { loginWithLeetCode } from '../shared/leetcode-auth.js';
import { loginWithAtCoder } from '../shared/atcoder-auth.js';
import { loginWithCodeChef } from '../shared/codechef-auth.js';
import { getAtCoderCatalog, describeProblem, atcoderSlug, AC_SUBMISSIONS_URL } from '../shared/atcoder-catalog.js';
import { startDeviceFlow, pollForGitHubToken, fetchGitHubIdentity, listInstalledRepositories, createRepository, getPrimaryInstallation, DEFAULT_GITHUB_APP_CLIENT_ID } from '../shared/github-oauth.js';
import { getEffectiveGithubToken } from '../shared/github-auth.js';
import { sleep, waitForTabComplete, sendToTab } from '../shared/tab-rpc.js';

// The selected repo lives in chrome.storage.local (key: githubRepo) as the
// single source of truth — no manual "owner/repo" field to keep in sync
// with it anymore, since it's always set by either the repo picker or repo
// creation below.
let selectedRepoFullName = '';

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('saveBtn').addEventListener('click', saveOptions);
document.getElementById('testBtn').addEventListener('click', onTestConnection);
document.getElementById('extensionVersion').textContent = `v${chrome.runtime.getManifest().version}`;

function saveOptions() {
    const enableLeetCode = document.getElementById('enableLeetCode').checked;
    const enableCodeforces = document.getElementById('enableCodeforces').checked;
    const enableAtCoder = document.getElementById('enableAtCoder').checked;
    const enableCodeChef = document.getElementById('enableCodeChef').checked;

    chrome.storage.local.set({ enableLeetCode, enableCodeforces, enableAtCoder, enableCodeChef }, () => {
        showStatus('saveStatus', 'Settings saved!', 'success');
    });
}

function restoreOptions() {
    chrome.storage.local.get([
        'githubRepo', 'enableLeetCode', 'enableCodeforces', 'enableAtCoder', 'enableCodeChef',
        'cfOauthProfile', 'lcProfile', 'acProfile', 'ccProfile', 'githubOauthProfile', 'githubRepoOptions'
    ], (items) => {
        selectedRepoFullName = items.githubRepo || '';

        if (items.enableLeetCode !== undefined) document.getElementById('enableLeetCode').checked = items.enableLeetCode;
        if (items.enableCodeforces !== undefined) document.getElementById('enableCodeforces').checked = items.enableCodeforces;
        if (items.enableAtCoder !== undefined) document.getElementById('enableAtCoder').checked = items.enableAtCoder;
        if (items.enableCodeChef !== undefined) document.getElementById('enableCodeChef').checked = items.enableCodeChef;

        renderCfAccountState(items.cfOauthProfile || null);
        renderLcAccountState(items.lcProfile || null);
        renderAcAccountState(items.acProfile || null);
        renderCcAccountState(items.ccProfile || null);
        renderGhAccountState(items.githubOauthProfile || null, items.githubRepoOptions || []);
        updateHistorySyncAvailability();
    });
}

/**
 * Keeps every historical-sync button in the right state: each one needs its
 * own connected account, and while one import is running the other platforms'
 * buttons are disabled so two runs can't fight over the same GitHub queue.
 */
function updateHistorySyncAvailability() {
    chrome.storage.local.get(['cfOauthProfile', 'lcProfile', 'acProfile', 'ccProfile'], ({ cfOauthProfile, lcProfile, acProfile, ccProfile }) => {
        const busyWith = activeImport ? activeImport.key : null;
        document.getElementById('syncHistoryBtn').disabled =
            !cfOauthProfile || (busyWith !== null && busyWith !== 'codeforces');
        document.getElementById('syncLeetCodeHistoryBtn').disabled =
            !lcProfile || (busyWith !== null && busyWith !== 'leetcode');
        document.getElementById('syncAtCoderHistoryBtn').disabled =
            !acProfile || (busyWith !== null && busyWith !== 'atcoder');
        document.getElementById('syncCodeChefHistoryBtn').disabled =
            !ccProfile || (busyWith !== null && busyWith !== 'codechef');
    });
}

/**
 * Reflects the verified-login state in the UI: shows the connected profile
 * card when present.
 */
function renderCfAccountState(profile) {
    const connectedPanel = document.getElementById('cfConnectedPanel');
    const setupPanel = document.getElementById('cfSetupPanel');

    if (profile && profile.handle) {
        document.getElementById('cfAvatar').src = profile.avatar || '../images/icon128.png';
        document.getElementById('cfConnectedHandle').textContent = profile.handle;
        document.getElementById('cfConnectedRating').textContent =
            profile.rating !== null && profile.rating !== undefined ? `Rating: ${profile.rating}` : 'Unrated';
        connectedPanel.style.display = 'flex';
        setupPanel.style.display = 'none';
    } else {
        connectedPanel.style.display = 'none';
        setupPanel.style.display = 'block';
    }
}

document.getElementById('cfConnectBtn').addEventListener('click', onConnectCodeforces);
document.getElementById('cfDisconnectBtn').addEventListener('click', onDisconnectCodeforces);

async function onConnectCodeforces() {
    const btn = document.getElementById('cfConnectBtn');
    btn.disabled = true;
    showStatus('cfConnectStatus', 'Opening Codeforces login…', 'info');

    try {
        const profile = await loginWithCodeforces({
            clientId: DEFAULT_CF_OAUTH_CLIENT_ID,
            exchangeUrl: DEFAULT_CF_OAUTH_EXCHANGE_URL
        });

        await chrome.storage.local.set({ cfOauthProfile: profile });

        renderCfAccountState(profile);
        updateHistorySyncAvailability();
        showStatus('cfConnectStatus', `Connected as ${profile.handle}.`, 'success');
    } catch (e) {
        showStatus('cfConnectStatus', e.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

async function onDisconnectCodeforces() {
    await chrome.storage.local.remove('cfOauthProfile');
    renderCfAccountState(null);
    updateHistorySyncAvailability();
    showStatus('cfConnectStatus', 'Disconnected.', 'info');
}

/**
 * The LeetCode equivalent of renderCfAccountState. Same card, same states —
 * only the flow behind the button differs (see shared/leetcode-auth.js).
 */
function renderLcAccountState(profile) {
    const connectedPanel = document.getElementById('lcConnectedPanel');
    const setupPanel = document.getElementById('lcSetupPanel');

    if (profile && profile.username) {
        document.getElementById('lcAvatar').src = profile.avatar || '../images/icon128.png';
        document.getElementById('lcConnectedUser').textContent = profile.username;
        document.getElementById('lcConnectedRanking').textContent =
            profile.ranking ? `Rank: #${profile.ranking.toLocaleString()}` : 'Signed in via leetcode.com';
        connectedPanel.style.display = 'flex';
        setupPanel.style.display = 'none';
    } else {
        connectedPanel.style.display = 'none';
        setupPanel.style.display = 'block';
    }
}

document.getElementById('lcConnectBtn').addEventListener('click', onConnectLeetCode);
document.getElementById('lcDisconnectBtn').addEventListener('click', onDisconnectLeetCode);

async function onConnectLeetCode() {
    const btn = document.getElementById('lcConnectBtn');
    btn.disabled = true;

    try {
        const profile = await loginWithLeetCode({
            onStatus: (message) => showStatus('lcConnectStatus', message, 'info')
        });

        await chrome.storage.local.set({ lcProfile: profile });

        renderLcAccountState(profile);
        updateHistorySyncAvailability();
        showStatus('lcConnectStatus', `Connected as ${profile.username}.`, 'success');
    } catch (e) {
        showStatus('lcConnectStatus', e.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

async function onDisconnectLeetCode() {
    await chrome.storage.local.remove('lcProfile');
    renderLcAccountState(null);
    updateHistorySyncAvailability();
    showStatus('lcConnectStatus', 'Disconnected.', 'info');
}

/**
 * The AtCoder equivalent of renderLcAccountState. AtCoder serves no avatar
 * URL of its own, so the card falls back to the extension icon.
 */
function renderAcAccountState(profile) {
    const connectedPanel = document.getElementById('acConnectedPanel');
    const setupPanel = document.getElementById('acSetupPanel');

    if (profile && profile.username) {
        document.getElementById('acAvatar').src = profile.avatar || '../images/icon128.png';
        document.getElementById('acConnectedUser').textContent = profile.username;
        document.getElementById('acConnectedRating').textContent =
            profile.rating !== null && profile.rating !== undefined ? `Rating: ${profile.rating}` : 'Unrated';
        connectedPanel.style.display = 'flex';
        setupPanel.style.display = 'none';
    } else {
        connectedPanel.style.display = 'none';
        setupPanel.style.display = 'block';
    }
}

document.getElementById('acConnectBtn').addEventListener('click', onConnectAtCoder);
document.getElementById('acDisconnectBtn').addEventListener('click', onDisconnectAtCoder);

async function onConnectAtCoder() {
    const btn = document.getElementById('acConnectBtn');
    btn.disabled = true;

    try {
        const profile = await loginWithAtCoder({
            onStatus: (message) => showStatus('acConnectStatus', message, 'info')
        });

        await chrome.storage.local.set({ acProfile: profile });

        renderAcAccountState(profile);
        updateHistorySyncAvailability();
        showStatus('acConnectStatus', `Connected as ${profile.username}.`, 'success');
    } catch (e) {
        showStatus('acConnectStatus', e.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

async function onDisconnectAtCoder() {
    await chrome.storage.local.remove('acProfile');
    renderAcAccountState(null);
    updateHistorySyncAvailability();
    showStatus('acConnectStatus', 'Disconnected.', 'info');
}

/**
 * The CodeChef equivalent of renderAcAccountState. CodeChef does serve an
 * avatar URL of its own, so the card uses it when there is one.
 */
function renderCcAccountState(profile) {
    const connectedPanel = document.getElementById('ccConnectedPanel');
    const setupPanel = document.getElementById('ccSetupPanel');

    if (profile && profile.username) {
        document.getElementById('ccAvatar').src = profile.avatar || '../images/icon128.png';
        document.getElementById('ccConnectedUser').textContent = profile.username;
        document.getElementById('ccConnectedRating').textContent =
            profile.rating !== null && profile.rating !== undefined ? `Rating: ${profile.rating}` : 'Unrated';
        connectedPanel.style.display = 'flex';
        setupPanel.style.display = 'none';
    } else {
        connectedPanel.style.display = 'none';
        setupPanel.style.display = 'block';
    }
}

document.getElementById('ccConnectBtn').addEventListener('click', onConnectCodeChef);
document.getElementById('ccDisconnectBtn').addEventListener('click', onDisconnectCodeChef);

async function onConnectCodeChef() {
    const btn = document.getElementById('ccConnectBtn');
    btn.disabled = true;

    try {
        const profile = await loginWithCodeChef({
            onStatus: (message) => showStatus('ccConnectStatus', message, 'info')
        });

        await chrome.storage.local.set({ ccProfile: profile });

        renderCcAccountState(profile);
        updateHistorySyncAvailability();
        showStatus('ccConnectStatus', `Connected as ${profile.username}.`, 'success');
    } catch (e) {
        showStatus('ccConnectStatus', e.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

async function onDisconnectCodeChef() {
    await chrome.storage.local.remove('ccProfile');
    renderCcAccountState(null);
    updateHistorySyncAvailability();
    showStatus('ccConnectStatus', 'Disconnected.', 'info');
}

/**
 * Reflects GitHub App connection state: shows the connected profile card,
 * and shows/populates the repo picker (only repos the App is actually
 * installed on) in place of typing "owner/repo" by hand.
 */
function renderGhAccountState(profile, repos) {
    const connectedPanel = document.getElementById('ghConnectedPanel');
    const setupPanel = document.getElementById('ghConnectSetup');
    const pickerGroup = document.getElementById('githubRepoPickerGroup');
    const createGroup = document.getElementById('githubCreateRepoGroup');
    const select = document.getElementById('githubRepoSelect');

    if (profile && profile.login) {
        document.getElementById('ghAvatar').src = profile.avatar || '../images/icon128.png';
        document.getElementById('ghConnectedUser').textContent = profile.login;
        connectedPanel.style.display = 'flex';
        setupPanel.style.display = 'none';
        createGroup.style.display = 'block';

        select.innerHTML = '';
        for (const repo of repos || []) {
            const option = document.createElement('option');
            option.value = repo.fullName;
            option.textContent = repo.fullName;
            select.appendChild(option);
        }

        if (repos && repos.length) {
            pickerGroup.style.display = 'block';

            // Rendering must not change which repository receives commits.
            // This used to fall back to repos[0] and write it straight to
            // storage, so merely *opening* the options page after the App was
            // reinstalled (or the repo renamed) silently repointed every future
            // push at an unrelated repository. If the saved repo isn't in the
            // list any more, leave the picker unselected and say so — choosing
            // one is the user's call.
            const savedIsAvailable = repos.some(r => r.fullName === selectedRepoFullName);

            if (savedIsAvailable) {
                select.value = selectedRepoFullName;
            } else if (!selectedRepoFullName) {
                // First-time setup: nothing has been chosen yet, so defaulting
                // to the first repo replaces nothing and saves a click. This is
                // the only case where rendering may write a selection.
                select.value = repos[0].fullName;
                selectedRepoFullName = select.value;
                chrome.storage.local.set({ githubRepo: selectedRepoFullName });
            } else {
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = `Select a repository (${selectedRepoFullName} is no longer available)`;
                select.insertBefore(placeholder, select.firstChild);
                select.value = '';

                showStatus(
                    'ghConnectStatus',
                    `AlgoPush no longer has access to ${selectedRepoFullName}. Choose a repository below — syncing keeps using it until you do.`,
                    'error'
                );
            }
        } else {
            pickerGroup.style.display = 'none';
        }
    } else {
        connectedPanel.style.display = 'none';
        setupPanel.style.display = 'block';
        pickerGroup.style.display = 'none';
        createGroup.style.display = 'none';
        select.innerHTML = '';
    }
}

document.getElementById('ghConnectBtn').addEventListener('click', onConnectGithub);
document.getElementById('ghDisconnectBtn').addEventListener('click', onDisconnectGithub);
document.getElementById('createRepoBtn').addEventListener('click', onCreateRepository);
document.getElementById('githubRepoSelect').addEventListener('change', (e) => {
    // The empty value is the "no longer available" placeholder — selecting it
    // is not a choice of repository, so it must not be saved over the old one.
    if (!e.target.value) return;
    selectedRepoFullName = e.target.value;
    chrome.storage.local.set({ githubRepo: selectedRepoFullName });
});

async function onConnectGithub() {
    const btn = document.getElementById('ghConnectBtn');
    const devicePanel = document.getElementById('ghDeviceCodePanel');

    btn.disabled = true;
    devicePanel.style.display = 'none';
    showStatus('ghConnectStatus', 'Requesting a login code from GitHub…', 'info');

    try {
        const { device_code, user_code, verification_uri, expires_in, interval } =
            await startDeviceFlow(DEFAULT_GITHUB_APP_CLIENT_ID);

        document.getElementById('ghUserCode').textContent = user_code;
        document.getElementById('ghVerificationLink').href = verification_uri;
        document.getElementById('ghVerificationLink').textContent = verification_uri.replace(/^https?:\/\//, '');
        devicePanel.style.display = 'block';
        showStatus('ghConnectStatus', 'Waiting for you to approve on GitHub…', 'info');

        chrome.tabs.create({ url: verification_uri, active: true });

        const tokenData = await pollForGitHubToken(DEFAULT_GITHUB_APP_CLIENT_ID, device_code, interval, expires_in);
        const profile = await fetchGitHubIdentity(tokenData.access_token);
        const repos = await listInstalledRepositories(tokenData.access_token);

        // Only present if the GitHub App has "Expire user authorization
        // tokens" turned on — handled either way, see shared/github-auth.js.
        await chrome.storage.local.set({
            githubOauthToken: tokenData.access_token,
            githubOauthRefreshToken: tokenData.refresh_token || null,
            githubOauthExpiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
            githubOauthProfile: profile,
            githubRepoOptions: repos
        });

        devicePanel.style.display = 'none';
        renderGhAccountState(profile, repos);

        if (repos.length === 0) {
            showStatus('ghConnectStatus', `Connected as ${profile.login}, but the AlgoPush GitHub App isn't installed on any repo yet — install it (choose "All repositories") from your GitHub App settings, then reconnect.`, 'error');
        } else {
            showStatus('ghConnectStatus', `Connected as ${profile.login}.`, 'success');
        }
    } catch (e) {
        devicePanel.style.display = 'none';
        showStatus('ghConnectStatus', e.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

async function onDisconnectGithub() {
    await chrome.storage.local.remove(['githubOauthToken', 'githubOauthRefreshToken', 'githubOauthExpiresAt', 'githubOauthProfile', 'githubRepoOptions', 'githubRepo']);
    selectedRepoFullName = '';
    renderGhAccountState(null, []);
    showStatus('ghConnectStatus', 'Disconnected.', 'info');
}

async function onCreateRepository() {
    const name = document.getElementById('newRepoName').value.trim();
    const btn = document.getElementById('createRepoBtn');

    if (!name) {
        showStatus('createRepoStatus', 'Enter a name first.', 'error');
        return;
    }
    if (!/^[\w.-]+$/.test(name)) {
        showStatus('createRepoStatus', 'Repo names can only contain letters, numbers, hyphens, underscores, and dots.', 'error');
        return;
    }

    const { githubOauthToken, githubOauthProfile } = await chrome.storage.local.get(['githubOauthToken', 'githubOauthProfile']);
    if (!githubOauthToken) {
        showStatus('createRepoStatus', 'Connect GitHub first.', 'error');
        return;
    }

    btn.disabled = true;
    showStatus('createRepoStatus', 'Creating repository…', 'info');

    try {
        const installation = await getPrimaryInstallation(githubOauthToken, githubOauthProfile && githubOauthProfile.login);
        const newRepo = await createRepository(githubOauthToken, name, installation && installation.id);

        const { githubRepoOptions = [] } = await chrome.storage.local.get('githubRepoOptions');
        const updatedRepos = [...githubRepoOptions, { fullName: newRepo.fullName, defaultBranch: newRepo.defaultBranch, installationId: installation && installation.id }];

        selectedRepoFullName = newRepo.fullName;
        await chrome.storage.local.set({ githubRepoOptions: updatedRepos, githubRepo: newRepo.fullName });
        document.getElementById('newRepoName').value = '';

        renderGhAccountState(githubOauthProfile, updatedRepos);
        showStatus('createRepoStatus', `Created ${newRepo.fullName} and selected it.`, 'success');
    } catch (e) {
        showStatus('createRepoStatus', e.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

async function onTestConnection() {
    const token = await getEffectiveGithubToken();

    if (!token || !selectedRepoFullName) {
        showStatus('testStatus', 'Connect GitHub and choose a repo first.', 'error');
        return;
    }

    const parts = selectedRepoFullName.split('/');
    if (parts.length !== 2) {
        showStatus('testStatus', 'Repo must be in owner/repo format.', 'error');
        return;
    }

    const [owner, name] = parts;

    document.getElementById('testBtn').disabled = true;
    showStatus('testStatus', 'Testing...', 'info');

    try {
        await testConnection(token, owner, name);
        const resolvedBranch = await resolveBranch(token, owner, name, '');
        showStatus('testStatus', `Connection successful — commits will go to ${resolvedBranch}.`, 'success');
    } catch (e) {
        showStatus('testStatus', e.message, 'error');
    } finally {
        document.getElementById('testBtn').disabled = false;
    }
}

document.getElementById('clearDataBtn').addEventListener('click', onClearData);

async function onClearData() {
    if (!confirm('This will disconnect GitHub, Codeforces, LeetCode, AtCoder, and CodeChef and remove local sync history from this browser. Continue?')) {
        return;
    }
    await chrome.storage.local.clear();
    selectedRepoFullName = '';
    document.getElementById('enableLeetCode').checked = true;
    document.getElementById('enableCodeforces').checked = true;
    document.getElementById('enableAtCoder').checked = true;
    document.getElementById('enableCodeChef').checked = true;
    renderCfAccountState(null);
    renderLcAccountState(null);
    renderAcAccountState(null);
    renderCcAccountState(null);
    renderGhAccountState(null, []);
    updateHistorySyncAvailability();
    showStatus('clearStatus', 'Saved data cleared.', 'success');
}


/* ==================================================================== *
 * Historical import — shared engine
 *
 * Both platforms need the same thing: read a list of everything already
 * solved, fetch each solution's source from a real, signed-in page, and push
 * it to GitHub. What differs is only *how* a list and a source are obtained,
 * so that part lives in the two small adapters below and everything that
 * makes the run survivable is shared:
 *
 *   - ONE background tab per run, loaded once and reused. The Codeforces
 *     import used to navigate a tab per submission, which is exactly the
 *     fingerprint Cloudflare's bot management scores against — that is why a
 *     27-submission import came back "blocked 27 of 27".
 *   - Everything already present in the synced index is skipped, so a run is
 *     resumable: stop it, close the browser, re-run, and it continues.
 *   - Transient failures back off and retry; anti-bot challenges are
 *     recovered from (silently first, then by handing off to the user) rather
 *     than failing every remaining item.
 *   - The root README index is written ONCE at the end of the run instead of
 *     after every submission (see `deferIndexUpdate` in the service worker).
 *   - The button doubles as Stop, and there is a real progress bar.
 * ==================================================================== */

const HISTORY_HASH = '#algopush-history';
const HISTORY_ITEM_ATTEMPTS = 4;
const HISTORY_CHALLENGE_WAIT_MS = 5 * 60 * 1000;

/** Non-null only while an import is in flight; doubles as the cancel flag. */
let activeImport = null;

/* ------------------------------ UI helpers ----------------------------- */

function setImportProgress(platform, done, total) {
    const wrap = document.getElementById(platform.progressId);
    const bar = document.getElementById(platform.progressBarId);
    if (!wrap || !bar) return;
    if (!total) {
        wrap.style.display = 'none';
        bar.style.width = '0';
        return;
    }
    wrap.style.display = 'block';
    bar.style.width = `${Math.round((done / total) * 100)}%`;
}

function setImportButton(platform, label, disabled = false) {
    const btn = document.getElementById(platform.buttonId);
    btn.textContent = label;
    btn.disabled = disabled;
}

/* ---------------------------- tab plumbing ---------------------------- *
 *
 * waitForTabComplete / sendToTab live in shared/tab-rpc.js — the LeetCode
 * connect flow drives a background tab exactly the same way.
 * ---------------------------------------------------------------------- */

/**
 * Guarantees `state.tabId` points at a loaded tab on the platform's site,
 * recreating it if the user closed it mid-run. One tab for the whole import.
 */
async function ensureHistoryTab(state, platform) {
    if (state.tabId !== null) {
        try {
            const tab = await chrome.tabs.get(state.tabId);
            if (tab && platform.hostPattern.test(tab.url || '')) return state.tabId;
        } catch (_) {
            // Tab was closed — fall through and open a fresh one.
        }
    }

    const tab = await chrome.tabs.create({ url: platform.tabUrl(state), active: false });
    state.tabId = tab.id;
    await waitForTabComplete(tab.id);
    // Give the content script a moment to register its message listener.
    await sleep(400);
    return state.tabId;
}

/* -------------------------- challenge recovery ------------------------- */

/**
 * Handles a Cloudflare challenge without losing the run.
 *
 * First it retries silently: a managed challenge issued to a real browser
 * usually clears itself on a reload. Only if that fails twice does it bring
 * the tab forward and ask the user to click through, then resumes on its own
 * as soon as the page is usable again. Either way the import slows down
 * afterwards, since being challenged means the current pace was too fast.
 *
 * Returns true when the tab is usable again.
 */
async function recoverFromCloudflare(state, platform) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (activeImport.cancelled) return false;

        showStatus(platform.statusId, `${platform.siteName} ran a verification check — retrying automatically (${attempt}/2)…`, 'info');
        await sleep(3000 * attempt);

        await ensureHistoryTab(state, platform);
        try {
            await chrome.tabs.reload(state.tabId, { bypassCache: true });
            await waitForTabComplete(state.tabId);
        } catch (_) {
            state.tabId = null;
            await ensureHistoryTab(state, platform);
        }
        await sleep(1500);

        const status = await sendToTab(state.tabId, { type: platform.statusType });
        if (status && status.ok && !status.challenged) {
            state.paceMs = Math.min(state.paceMs + 500, platform.maxPaceMs);
            return true;
        }
    }

    // Hand off to the user — visibly, once, instead of failing every item.
    try {
        await chrome.tabs.update(state.tabId, { active: true });
        const tab = await chrome.tabs.get(state.tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_) { /* best effort */ }

    showStatus(platform.statusId, `${platform.siteName} needs a quick human verification. Complete the check in the ${platform.siteName} tab that just came to the front — the sync resumes by itself.`, 'info');

    const deadline = Date.now() + HISTORY_CHALLENGE_WAIT_MS;
    while (Date.now() < deadline) {
        if (activeImport.cancelled) return false;
        await sleep(2000);
        await ensureHistoryTab(state, platform);
        const status = await sendToTab(state.tabId, { type: platform.statusType }, { retries: 2, retryDelayMs: 500 });
        if (status && status.ok && !status.challenged) {
            if (state.optionsTabId !== null) {
                try { await chrome.tabs.update(state.optionsTabId, { active: true }); } catch (_) {}
            }
            state.paceMs = Math.min(state.paceMs + 800, platform.maxPaceMs);
            return true;
        }
    }

    return false;
}

/**
 * What a platform does when an item comes back `challenged` — i.e. the tab is
 * no longer usable as it stands. Codeforces means "Cloudflare is in the way",
 * AtCoder means "the session expired"; both are recoverable without losing
 * the run, but not the same way, so each platform brings its own and this is
 * only the default.
 */
function recoverTab(state, platform) {
    return (platform.recover || recoverFromCloudflare)(state, platform);
}

/**
 * AtCoder's version: the sign-in session lapsed mid-run.
 *
 * A reload is tried first, because the usual cause is a single request
 * landing on a stale cookie rather than a real sign-out. Only if the session
 * is genuinely gone does it bring the tab forward and let the user sign in on
 * AtCoder's own page, then resume by itself — the run keeps everything it has
 * already pushed either way.
 */
async function recoverAtCoderSession(state, platform) {
    if (activeImport.cancelled) return false;

    showStatus(platform.statusId, 'Rechecking your AtCoder session…', 'info');
    await ensureHistoryTab(state, platform);
    try {
        await chrome.tabs.reload(state.tabId);
        await waitForTabComplete(state.tabId);
    } catch (_) {
        state.tabId = null;
        await ensureHistoryTab(state, platform);
    }
    await sleep(1000);

    let status = await sendToTab(state.tabId, { type: platform.statusType });
    if (status && status.ok && status.signedIn) return true;

    // Genuinely signed out — hand off to AtCoder's own sign-in page.
    try {
        await chrome.tabs.update(state.tabId, { url: 'https://atcoder.jp/login', active: true });
        await waitForTabComplete(state.tabId);
        const tab = await chrome.tabs.get(state.tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_) { /* best effort */ }

    showStatus(platform.statusId, 'Your AtCoder session expired. Sign in again in the AtCoder tab that just came to the front — the sync resumes by itself.', 'info');

    const deadline = Date.now() + HISTORY_CHALLENGE_WAIT_MS;
    while (Date.now() < deadline) {
        if (activeImport.cancelled) return false;
        await sleep(2000);
        await ensureHistoryTab(state, platform);
        status = await sendToTab(state.tabId, { type: platform.statusType }, { retries: 2, retryDelayMs: 500 });
        if (status && status.ok && status.signedIn) {
            if (state.optionsTabId !== null) {
                try { await chrome.tabs.update(state.optionsTabId, { active: true }); } catch (_) {}
            }
            return true;
        }
    }

    return false;
}

/**
 * CodeChef's version: the tab stopped being usable, and there are two reasons
 * it could have.
 *
 * Cloudflare sits in front of CodeChef, so a request can be turned away
 * exactly as on Codeforces; and a source request answered with 401/403 means
 * the sign-in session lapsed instead. The tab itself tells the two apart, so
 * this reloads first (which clears the usual managed challenge and a merely
 * stale cookie), and only then hands off — to CodeChef's own sign-in page when
 * the session is genuinely gone, or to the challenge in the foreground when it
 * is not. Either way the run keeps everything it has already pushed and
 * resumes by itself.
 *
 * Returns true when the tab is usable again.
 */
async function recoverCodeChefTab(state, platform) {
    const isUsable = (status) => Boolean(status && status.ok && !status.challenged && status.signedIn);

    for (let attempt = 1; attempt <= 2; attempt++) {
        if (activeImport.cancelled) return false;

        showStatus(platform.statusId, `Rechecking your CodeChef session — retrying automatically (${attempt}/2)…`, 'info');
        await sleep(2000 * attempt);

        await ensureHistoryTab(state, platform);
        try {
            await chrome.tabs.reload(state.tabId, { bypassCache: true });
            await waitForTabComplete(state.tabId);
        } catch (_) {
            state.tabId = null;
            await ensureHistoryTab(state, platform);
        }
        await sleep(1500);

        const status = await sendToTab(state.tabId, { type: platform.statusType });
        if (isUsable(status)) {
            // Being turned away once means the current pace was too fast.
            state.paceMs = Math.min(state.paceMs + 500, platform.maxPaceMs);
            return true;
        }
        state.signedOut = Boolean(status && status.ok && !status.signedIn);
    }

    // Hand off to the user — visibly, once, instead of failing every item.
    try {
        if (state.signedOut) {
            await chrome.tabs.update(state.tabId, { url: 'https://www.codechef.com/login', active: true });
            await waitForTabComplete(state.tabId);
        } else {
            await chrome.tabs.update(state.tabId, { active: true });
        }
        const tab = await chrome.tabs.get(state.tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_) { /* best effort */ }

    showStatus(
        platform.statusId,
        state.signedOut
            ? 'Your CodeChef session expired. Sign in again in the CodeChef tab that just came to the front — the sync resumes by itself.'
            : 'CodeChef needs a quick human verification. Complete the check in the CodeChef tab that just came to the front — the sync resumes by itself.',
        'info'
    );

    const deadline = Date.now() + HISTORY_CHALLENGE_WAIT_MS;
    while (Date.now() < deadline) {
        if (activeImport.cancelled) return false;
        await sleep(2000);
        await ensureHistoryTab(state, platform);
        const status = await sendToTab(state.tabId, { type: platform.statusType }, { retries: 2, retryDelayMs: 500 });
        if (isUsable(status)) {
            if (state.optionsTabId !== null) {
                try { await chrome.tabs.update(state.optionsTabId, { active: true }); } catch (_) {}
            }
            state.signedOut = false;
            state.paceMs = Math.min(state.paceMs + 800, platform.maxPaceMs);
            return true;
        }
    }

    return false;
}

/* ------------------------------ the engine ----------------------------- */

/**
 * Confirms GitHub is actually usable before a long run starts. Without this,
 * a misconfigured repo surfaces as every single submission "failing" at the
 * very end — the single most confusing way this can go wrong.
 */
async function assertGithubReady() {
    const { githubRepo } = await chrome.storage.local.get('githubRepo');
    const token = await getEffectiveGithubToken();
    const [owner, repo] = (githubRepo || '').split('/');

    if (!token || !owner || !repo) {
        throw new Error('Connect GitHub and choose a repository first.');
    }
    try {
        await resolveBranch(token, owner, repo, '');
    } catch (e) {
        throw new Error(`GitHub is not ready: ${e.message}`);
    }
}

/**
 * Writes the coalesced root README index once, at the end of a run.
 * Deliberately non-fatal: the solutions themselves are already committed, and
 * the service worker re-attempts this on its own if it doesn't land here.
 */
async function flushSolutionIndex(state, platform) {
    if (state.synced === 0) return;
    showStatus(platform.statusId, 'Updating the solution index…', 'info');
    try {
        const result = await chrome.runtime.sendMessage({ type: 'FLUSH_README_INDEX' });
        if (result && result.ok === false) {
            console.warn('AlgoPush: solution index update deferred:', result.error);
        }
    } catch (e) {
        console.warn('AlgoPush: solution index update deferred:', e);
    }
}

async function runHistoricalImport(platform) {
    // The button doubles as Stop while this platform's run is in flight.
    if (activeImport) {
        if (activeImport.key === platform.key) {
            activeImport.cancelled = true;
            setImportButton(platform, 'Stopping…', true);
        } else {
            showStatus(platform.statusId, 'Another import is already running — let it finish or stop it first.', 'error');
        }
        return;
    }

    const state = {
        tabId: null,
        optionsTabId: null,
        paceMs: platform.paceMs,
        synced: 0,
        failed: 0,
        skipped: 0,
        lastError: '',
        halted: false,
        haltMessage: ''
    };
    activeImport = { key: platform.key, cancelled: false };

    try {
        const currentTab = await chrome.tabs.getCurrent();
        state.optionsTabId = currentTab ? currentTab.id : null;
    } catch (_) { /* options page opened outside a tab */ }

    setImportButton(platform, 'Stop Sync');
    setImportProgress(platform, 0, 0);
    updateHistorySyncAvailability();

    try {
        await platform.preflight(state);
        await assertGithubReady();

        showStatus(platform.statusId, `Opening ${platform.siteName}…`, 'info');
        await ensureHistoryTab(state, platform);
        await platform.probe(state, platform);

        showStatus(platform.statusId, 'Reading your solved problems…', 'info');
        const all = await platform.listItems(state, platform);

        if (all.length === 0) {
            showStatus(platform.statusId, `No accepted ${platform.siteName} submissions found for this account.`, 'info');
            return;
        }

        // Resume support: anything already in the synced index is done.
        const { syncedProblemsIndex = {} } = await chrome.storage.local.get('syncedProblemsIndex');
        const queue = all.filter(entry => !syncedProblemsIndex[entry.indexKey]);
        state.skipped = all.length - queue.length;

        if (queue.length === 0) {
            showStatus(platform.statusId, `Already up to date — all ${all.length} solved problems are in your repo.`, 'success');
            return;
        }

        showStatus(platform.statusId, `Found ${all.length} solved problems (${state.skipped} already synced). Importing ${queue.length}…`, 'info');

        for (let i = 0; i < queue.length; i++) {
            if (activeImport.cancelled) break;

            const entry = queue[i];
            setImportProgress(platform, i, queue.length);

            let submission = null;
            let lastError = '';

            for (let attempt = 0; attempt < HISTORY_ITEM_ATTEMPTS; attempt++) {
                if (activeImport.cancelled) break;

                await ensureHistoryTab(state, platform);
                const result = await platform.fetchSubmission(state, entry);

                if (result.submission) {
                    submission = result.submission;
                    break;
                }

                lastError = result.error || `${platform.siteName} returned no source.`;

                if (result.challenged) {
                    if (await recoverTab(state, platform)) continue;
                    state.halted = true;
                    state.haltMessage = platform.haltMessage;
                    break;
                }
                if (result.retryable) {
                    // Back off hard, and permanently slow the rest of the run
                    // down: being throttled once means the pace was too fast.
                    state.paceMs = Math.min(state.paceMs + 400, platform.maxPaceMs);
                    showStatus(platform.statusId, `${platform.siteName} is throttling — waiting before retrying (${attempt + 1}/${HISTORY_ITEM_ATTEMPTS})…`, 'info');
                    await sleep(2000 * Math.pow(2, attempt));
                    continue;
                }
                break; // Permanent problem with this one item.
            }

            if (state.halted || activeImport.cancelled) break;

            if (!submission) {
                state.failed++;
                state.lastError = lastError;
            } else {
                // `deferIndexUpdate` keeps the service worker from rewriting and
                // committing the root README after every single submission;
                // flushSolutionIndex() writes it once when the run ends.
                const pushResult = await chrome.runtime.sendMessage({ ...submission, deferIndexUpdate: true });
                if (pushResult && pushResult.ok) {
                    state.synced++;
                } else {
                    state.failed++;
                    state.lastError = (pushResult && pushResult.error) || 'Unknown GitHub sync error.';
                }
            }

            setImportProgress(platform, i + 1, queue.length);
            showStatus(platform.statusId, `Pushed ${state.synced}, failed ${state.failed}, of ${queue.length}…`, 'info');

            // Human-paced, jittered gap between source requests.
            await sleep(state.paceMs + Math.random() * platform.jitterMs);
        }

        await flushSolutionIndex(state, platform);

        const tail = state.skipped ? ` (${state.skipped} already synced)` : '';

        if (state.halted) {
            showStatus(platform.statusId, `Paused after ${state.synced} pushed${tail} — ${state.haltMessage}`, 'error');
        } else if (activeImport.cancelled) {
            showStatus(platform.statusId, `Stopped — ${state.synced} pushed${tail}. Run the sync again to continue from here.`, 'info');
        } else if (state.failed === 0) {
            showStatus(platform.statusId, `Done — ${state.synced} submissions pushed to GitHub${tail}.`, 'success');
        } else {
            showStatus(platform.statusId, `Done — ${state.synced} pushed, ${state.failed} failed${tail}. Re-run to retry the failures. Last error: ${state.lastError}`, 'error');
        }
    } catch (e) {
        await flushSolutionIndex(state, platform);
        showStatus(platform.statusId, `Error: ${e.message}`, 'error');
    } finally {
        if (state.tabId !== null) {
            try { await chrome.tabs.remove(state.tabId); } catch (_) {}
        }
        setImportProgress(platform, 0, 0);
        activeImport = null;
        setImportButton(platform, platform.buttonLabel, false);
        updateHistorySyncAvailability();
    }
}

/* --------------------------- Codeforces adapter ------------------------- *
 *
 * Codeforces has no public API for submission source code, so the source has
 * to come from the site itself — but it does not need a page load per
 * submission. The content script calls /data/submitSource, the same
 * same-origin request the site's own "source" button makes, from one already
 * open page.
 * ---------------------------------------------------------------------- */

const codeforcesImport = {
    key: 'codeforces',
    siteName: 'Codeforces',
    buttonId: 'syncHistoryBtn',
    buttonLabel: 'Sync Old Codeforces Submissions',
    statusId: 'historicalStatus',
    progressId: 'cfHistoryProgress',
    progressBarId: 'cfHistoryProgressBar',
    hostPattern: /codeforces\.com/,
    statusType: 'CF_HISTORY_STATUS',
    haltMessage: 'Codeforces kept asking for verification. Open codeforces.com, browse normally for a minute, then run the sync again — it picks up where it stopped.',
    paceMs: 800,
    jitterMs: 600,
    maxPaceMs: 4000,

    async preflight(state) {
        const { cfOauthProfile } = await chrome.storage.local.get('cfOauthProfile');
        if (!cfOauthProfile || !cfOauthProfile.handle) {
            throw new Error('Connect your Codeforces account first.');
        }
        state.handle = cfOauthProfile.handle;
    },

    tabUrl(state) {
        return `https://codeforces.com/submissions/${encodeURIComponent(state.handle)}${HISTORY_HASH}`;
    },

    async probe(state, platform) {
        let status = await sendToTab(state.tabId, { type: 'CF_HISTORY_STATUS' });
        if (status.challenged) {
            if (!(await recoverTab(state, platform))) {
                throw new Error('Codeforces is showing an anti-bot check that did not clear. Open codeforces.com, complete it, then run the sync again.');
            }
            status = await sendToTab(state.tabId, { type: 'CF_HISTORY_STATUS' });
        }
        if (!status.ok) {
            throw new Error(status.error || 'The Codeforces tab could not be reached. Make sure codeforces.com loads in this browser, then try again.');
        }
        if (!status.signedIn) {
            throw new Error('You are not signed in to Codeforces in this browser. Sign in at codeforces.com, then run the sync again.');
        }
    },

    async listItems(state, platform) {
        let listing = await sendToTab(state.tabId, { type: 'CF_HISTORY_USER_STATUS', handle: state.handle });
        if (listing.challenged && await recoverTab(state, platform)) {
            listing = await sendToTab(state.tabId, { type: 'CF_HISTORY_USER_STATUS', handle: state.handle });
        }
        if (!listing.ok) {
            throw new Error(listing.error || 'Could not read your Codeforces submissions.');
        }

        // user.status returns newest first, so the first OK verdict seen for a
        // problem is the most recent accepted submission for it.
        const entries = [];
        const seen = new Set();
        for (const sub of listing.submissions) {
            if (sub.verdict !== 'OK' || !sub.problem || sub.problem.contestId === undefined) continue;
            const slug = `${sub.problem.contestId}-${sub.problem.index}`;
            if (seen.has(slug)) continue;
            seen.add(slug);
            entries.push({ indexKey: `Codeforces:${slug}`, title: sub.problem.name, slug, sub });
        }
        return entries;
    },

    async fetchSubmission(state, entry) {
        const result = await sendToTab(state.tabId, { type: 'CF_HISTORY_SOURCE', submissionId: entry.sub.id });
        if (!result.code) return result;

        const { problem } = entry.sub;
        return {
            submission: {
                type: 'SUBMISSION_ACCEPTED',
                platform: 'Codeforces',
                submissionId: entry.sub.id,
                title: problem.name,
                slug: entry.slug,
                difficulty: problem.rating ? problem.rating.toString() : 'Unknown',
                tags: problem.tags || [],
                code: result.code,
                language: entry.sub.programmingLanguage
            }
        };
    }
};

/* --------------------------- LeetCode adapter -------------------------- *
 *
 * LeetCode does expose the data through GraphQL, but only to a signed-in
 * session — so it runs from a real leetcode.com tab for the same reason, and
 * is paced because GraphQL throttles a long run of back-to-back lookups.
 * ---------------------------------------------------------------------- */

const leetcodeImport = {
    key: 'leetcode',
    siteName: 'LeetCode',
    buttonId: 'syncLeetCodeHistoryBtn',
    buttonLabel: 'Sync Old LeetCode Submissions',
    statusId: 'leetcodeHistoricalStatus',
    progressId: 'lcHistoryProgress',
    progressBarId: 'lcHistoryProgressBar',
    hostPattern: /leetcode\.com/,
    statusType: 'LC_HISTORY_STATUS',
    haltMessage: 'LeetCode kept refusing the request. Open leetcode.com, make sure you are still signed in, then run the sync again — it picks up where it stopped.',
    paceMs: 450,
    jitterMs: 350,
    maxPaceMs: 3000,

    async preflight(state) {
        const { lcProfile } = await chrome.storage.local.get('lcProfile');
        if (!lcProfile || !lcProfile.username) {
            throw new Error('Connect your LeetCode account first.');
        }
        state.connectedUsername = lcProfile.username;
    },

    tabUrl() {
        return `https://leetcode.com/problemset/${HISTORY_HASH}`;
    },

    async probe(state) {
        const status = await sendToTab(state.tabId, { type: 'LC_HISTORY_STATUS' });
        if (!status.ok) {
            throw new Error(status.error || 'The LeetCode tab could not be reached. Make sure leetcode.com loads in this browser, then try again.');
        }
        if (!status.signedIn) {
            throw new Error('You are not signed in to LeetCode in this browser. Sign in at leetcode.com, then run the sync again.');
        }
        // The browser can be signed in as someone else than the account that
        // was connected — importing one person's solutions under another's
        // name is worse than refusing, so say so instead.
        if (status.username && state.connectedUsername && status.username !== state.connectedUsername) {
            throw new Error(`This browser is signed in to LeetCode as ${status.username}, but AlgoPush is connected to ${state.connectedUsername}. Reconnect your LeetCode account, or switch accounts on leetcode.com.`);
        }
        state.username = status.username;
    },

    async listItems(state) {
        const listing = await sendToTab(state.tabId, { type: 'LC_HISTORY_QUESTIONS' }, { retries: 3, retryDelayMs: 1000 });
        if (!listing.ok) {
            throw new Error(listing.error || 'Could not read your solved LeetCode problems.');
        }
        return (listing.questions || []).map(question => ({
            indexKey: `LeetCode:${question.titleSlug}`,
            title: question.title,
            question
        }));
    },

    async fetchSubmission(state, entry) {
        return sendToTab(state.tabId, { type: 'LC_HISTORY_SUBMISSION', question: entry.question });
    }
};

/* --------------------------- AtCoder adapter ---------------------------- *
 *
 * AtCoder is the one platform that needs two sources. It publishes no API at
 * all, so the *list* of what has been solved comes from the public AtCoder
 * Problems dataset (the same one the site's own difficulty estimates come
 * from — see shared/atcoder-catalog.js), while the *source code* comes from
 * atcoder.jp itself, which serves it only to the signed-in session on a real
 * page. Listing from the dataset also means the run costs one request to get
 * the whole history, instead of paging through hundreds of contest-scoped
 * submission pages on AtCoder's own servers.
 * ---------------------------------------------------------------------- */

// The endpoint answers with at most 500 submissions per call, so a long
// history is walked forward in time. The page cap is a guard against a
// pathological response, not a real limit: 400 pages is 200,000 submissions.
const AC_PAGE_LIMIT = 400;

/**
 * Fetches the user's entire submission history from the AtCoder Problems
 * dataset, walking `from_second` forward until a page adds nothing new.
 *
 * Paging by `epoch_second` rather than by an offset is what the endpoint
 * supports, and it has one sharp edge: several submissions can share the same
 * second, so the window is re-opened *at* the last second seen rather than
 * after it, and the overlap is removed by submission id. Advancing past the
 * second instead would quietly drop every submission that happened to share
 * it with a page boundary.
 */
async function fetchAllAtCoderSubmissions(user, onProgress) {
    const byId = new Map();
    let fromSecond = 0;

    for (let page = 0; page < AC_PAGE_LIMIT; page++) {
        const response = await fetch(`${AC_SUBMISSIONS_URL}?user=${encodeURIComponent(user)}&from_second=${fromSecond}`);
        if (!response.ok) {
            throw new Error(`AtCoder Problems returned HTTP ${response.status} while listing your submissions.`);
        }

        const batch = await response.json();
        if (!Array.isArray(batch) || batch.length === 0) break;

        let added = 0;
        let latestSecond = fromSecond;
        for (const submission of batch) {
            if (!byId.has(submission.id)) {
                byId.set(submission.id, submission);
                added++;
            }
            latestSecond = Math.max(latestSecond, submission.epoch_second || 0);
        }

        onProgress(byId.size);

        // Nothing new and no way forward — the history ends here.
        if (added === 0 && latestSecond <= fromSecond) break;
        fromSecond = latestSecond;

        // The dataset asks for roughly one request a second.
        await sleep(1000);
    }

    return [...byId.values()];
}

const atcoderImport = {
    key: 'atcoder',
    siteName: 'AtCoder',
    buttonId: 'syncAtCoderHistoryBtn',
    buttonLabel: 'Sync Old AtCoder Submissions',
    statusId: 'atcoderHistoricalStatus',
    progressId: 'acHistoryProgress',
    progressBarId: 'acHistoryProgressBar',
    hostPattern: /atcoder\.jp/,
    statusType: 'AC_HISTORY_STATUS',
    recover: recoverAtCoderSession,
    haltMessage: 'AtCoder would not keep you signed in. Sign in at atcoder.jp, then run the sync again — it picks up where it stopped.',
    paceMs: 1000,
    jitterMs: 700,
    maxPaceMs: 5000,

    async preflight(state) {
        const { acProfile } = await chrome.storage.local.get('acProfile');
        if (!acProfile || !acProfile.username) {
            throw new Error('Connect your AtCoder account first.');
        }
        state.connectedUsername = acProfile.username;
    },

    tabUrl() {
        return `https://atcoder.jp/home${HISTORY_HASH}`;
    },

    async probe(state, platform) {
        let status = await sendToTab(state.tabId, { type: 'AC_HISTORY_STATUS' });
        if (!status.ok) {
            throw new Error(status.error || 'The AtCoder tab could not be reached. Make sure atcoder.jp loads in this browser, then try again.');
        }
        if (!status.signedIn) {
            // Recoverable: let the user sign in rather than making them
            // restart the run.
            if (!(await recoverTab(state, platform))) {
                throw new Error('You are not signed in to AtCoder in this browser. Sign in at atcoder.jp, then run the sync again.');
            }
            status = await sendToTab(state.tabId, { type: 'AC_HISTORY_STATUS' });
        }
        // Importing one person's solutions under another's name is worse than
        // refusing, so say so instead.
        if (status.username && state.connectedUsername && status.username !== state.connectedUsername) {
            throw new Error(`This browser is signed in to AtCoder as ${status.username}, but AlgoPush is connected to ${state.connectedUsername}. Reconnect your AtCoder account, or switch accounts on atcoder.jp.`);
        }
        state.username = status.username || state.connectedUsername;
    },

    async listItems(state, platform) {
        const [submissions, catalog] = await Promise.all([
            fetchAllAtCoderSubmissions(state.username, (count) => {
                showStatus(platform.statusId, `Reading your AtCoder submissions… (${count} so far)`, 'info');
            }),
            // Titles and difficulty for the whole problemset, fetched once.
            getAtCoderCatalog().catch(error => {
                console.warn('AlgoPush: AtCoder problem metadata is unavailable for this run.', error);
                return {};
            })
        ]);

        // Ascending by time, so the last Accepted submission seen for a
        // problem is the most recent one — which is the one worth keeping.
        const newestByProblem = new Map();
        for (const submission of submissions.sort((a, b) => a.epoch_second - b.epoch_second)) {
            if (submission.result !== 'AC' || !submission.problem_id) continue;
            newestByProblem.set(submission.problem_id, submission);
        }

        return [...newestByProblem.values()].map(submission => {
            const slug = atcoderSlug(submission.contest_id, submission.problem_id);
            const described = describeProblem(catalog, submission.contest_id, submission.problem_id);
            return {
                indexKey: `AtCoder:${slug}`,
                title: described.title,
                slug,
                submission
            };
        });
    },

    async fetchSubmission(state, entry) {
        const { submission } = entry;
        const result = await sendToTab(state.tabId, {
            type: 'AC_HISTORY_SOURCE',
            contestId: submission.contest_id,
            submissionId: submission.id
        });

        if (!result.code) {
            // An expired session is recoverable, so surface it the way the
            // engine already knows how to recover from.
            if (result.signedOut) return { ...result, challenged: true };
            return result;
        }

        return {
            submission: {
                type: 'SUBMISSION_ACCEPTED',
                platform: 'AtCoder',
                submissionId: submission.id,
                title: entry.title,
                slug: entry.slug,
                contestId: submission.contest_id,
                problemId: submission.problem_id,
                // Difficulty and the contest-series tag are filled in by the
                // service worker, from the same catalog, so every path into
                // the repo files a problem identically.
                difficulty: 'Unknown',
                tags: [],
                code: result.code,
                language: submission.language || result.language || 'Unknown'
            }
        };
    }
};

/* --------------------------- CodeChef adapter --------------------------- *
 *
 * CodeChef is the most straightforward of the four, because the endpoints its
 * own front end uses are plain JSON and answer a same-origin request from a
 * signed-in page: `/recent/user` for the history and `/api/submission-code`
 * for one solution's source. The only awkward part is that the history comes
 * back as rendered table markup rather than data, and that it is paged 20-ish
 * rows at a time — so the run walks it once, newest first, and keeps the most
 * recent Accepted submission per problem.
 *
 * Asking for a page past the last one does not return empty: CodeChef returns
 * the last page again. The walk therefore stops on `max_page` *and* on a page
 * that contributes no submission id it has not already seen, so a change in
 * that behaviour cannot turn into an endless loop.
 * ---------------------------------------------------------------------- */

// 500 pages is roughly 10,000 submissions — a guard against a pathological
// response, not a real limit.
const CC_PAGE_LIMIT = 500;

/**
 * Reads one page of the submission list, surviving the two things that
 * interrupt a long walk.
 *
 * Unlike the other three platforms, whose listing is a single request, this
 * one makes a request per page — so a run long enough to be throttled part way
 * through is not a rare case, it is the expected one for a large history.
 * Giving up on the first 429 would throw away the whole listing, so a page is
 * retried with a widening gap, and every throttle permanently slows the rest
 * of the run down. A challenge is handed to the tab recovery instead, which
 * can reload or let the user clear it.
 *
 * Returns null when the user stopped the run part way through, so that reads
 * as "Stopped" rather than as an error.
 */
async function readSubmissionPage(state, platform, page) {
    let lastError = '';

    for (let attempt = 0; attempt < HISTORY_ITEM_ATTEMPTS; attempt++) {
        if (activeImport.cancelled) return null;

        await ensureHistoryTab(state, platform);
        const result = await sendToTab(state.tabId, { type: 'CC_HISTORY_PAGE', handle: state.username, page });

        if (result.ok) return result;

        lastError = result.error || 'CodeChef returned no submissions.';

        if (result.challenged) {
            if (await recoverTab(state, platform)) continue;
            throw new Error('CodeChef stopped answering while reading your submissions. Open codechef.com, make sure you are signed in, then run the sync again.');
        }
        if (result.retryable) {
            state.paceMs = Math.min(state.paceMs + 400, platform.maxPaceMs);
            showStatus(platform.statusId, `CodeChef is throttling — waiting before retrying (${attempt + 1}/${HISTORY_ITEM_ATTEMPTS})…`, 'info');
            await sleep(2000 * Math.pow(2, attempt));
            continue;
        }
        break; // Permanent problem with this page.
    }

    if (activeImport.cancelled) return null;
    throw new Error(`Could not read your CodeChef submissions: ${lastError}`);
}

const codechefImport = {
    key: 'codechef',
    siteName: 'CodeChef',
    buttonId: 'syncCodeChefHistoryBtn',
    buttonLabel: 'Sync Old CodeChef Submissions',
    statusId: 'codechefHistoricalStatus',
    progressId: 'ccHistoryProgress',
    progressBarId: 'ccHistoryProgressBar',
    hostPattern: /codechef\.com/,
    statusType: 'CC_HISTORY_STATUS',
    recover: recoverCodeChefTab,
    haltMessage: 'CodeChef kept refusing the request. Open codechef.com, make sure you are still signed in, then run the sync again — it picks up where it stopped.',
    // CodeChef throttles a burst of requests noticeably sooner than the other
    // three, so this starts slower than they do; the engine slows it further
    // on its own the first time a 429 comes back.
    paceMs: 1200,
    jitterMs: 800,
    maxPaceMs: 6000,

    async preflight(state) {
        const { ccProfile } = await chrome.storage.local.get('ccProfile');
        if (!ccProfile || !ccProfile.username) {
            throw new Error('Connect your CodeChef account first.');
        }
        state.connectedUsername = ccProfile.username;
    },

    tabUrl() {
        return `https://www.codechef.com/dashboard${HISTORY_HASH}`;
    },

    async probe(state, platform) {
        let status = await sendToTab(state.tabId, { type: 'CC_HISTORY_STATUS' });

        // A run must not die on the doorstep because CodeChef happened to be
        // rate-limiting the moment it started — that is transient by
        // definition, and the whole import is behind this one check.
        for (let attempt = 0; attempt < 3 && status.retryable && !status.ok; attempt++) {
            showStatus(platform.statusId, 'CodeChef is throttling — waiting before checking your session…', 'info');
            await sleep(3000 * (attempt + 1));
            status = await sendToTab(state.tabId, { type: 'CC_HISTORY_STATUS' });
        }

        if (status.challenged || (status.ok && !status.signedIn)) {
            // Both are recoverable: let the user clear the check or sign in
            // rather than making them restart the run.
            state.signedOut = Boolean(status.ok && !status.signedIn);
            if (!(await recoverTab(state, platform))) {
                throw new Error(state.signedOut
                    ? 'You are not signed in to CodeChef in this browser. Sign in at codechef.com, then run the sync again.'
                    : 'CodeChef is showing an anti-bot check that did not clear. Open codechef.com, complete it, then run the sync again.');
            }
            status = await sendToTab(state.tabId, { type: 'CC_HISTORY_STATUS' });
        }

        if (!status.ok) {
            throw new Error(status.error || 'The CodeChef tab could not be reached. Make sure codechef.com loads in this browser, then try again.');
        }
        // Importing one person's solutions under another's name is worse than
        // refusing, so say so instead.
        if (status.username && state.connectedUsername && status.username !== state.connectedUsername) {
            throw new Error(`This browser is signed in to CodeChef as ${status.username}, but AlgoPush is connected to ${state.connectedUsername}. Reconnect your CodeChef account, or switch accounts on codechef.com.`);
        }
        state.username = status.username || state.connectedUsername;
    },

    async listItems(state, platform) {
        const newestByProblem = new Map();
        const seenSubmissions = new Set();
        let unavailable = 0;
        let maxPage = 0;

        for (let page = 0; page <= maxPage && page < CC_PAGE_LIMIT; page++) {
            if (activeImport.cancelled) break;

            const result = await readSubmissionPage(state, platform, page);
            if (!result) break; // The run was stopped mid-walk.

            maxPage = Number(result.maxPage) || 0;

            let freshIds = 0;
            let repeatedIds = 0;
            for (const row of result.rows || []) {
                if (row.unavailable) {
                    // Accepted, but CodeChef is not offering the solution, so
                    // there is no source to fetch. This should not happen for
                    // your own submissions; it is counted rather than dropped
                    // so an unexpected one is visible in the console instead of
                    // quietly shrinking the total.
                    unavailable++;
                    continue;
                }
                if (seenSubmissions.has(row.id)) {
                    repeatedIds++;
                    continue;
                }
                seenSubmissions.add(row.id);
                freshIds++;
                // Newest first, so the first Accepted submission seen for a
                // problem is the most recent one — the one worth keeping.
                if (!newestByProblem.has(row.problemCode)) newestByProblem.set(row.problemCode, row);
            }

            showStatus(platform.statusId, `Reading your CodeChef submissions… (${newestByProblem.size} solved problems, page ${page + 1} of ${maxPage + 1})`, 'info');

            // A page made up entirely of submissions already read means paging
            // has stopped advancing — see the note above about asking past the
            // last page. Both halves of this test matter: a page whose
            // submissions were *all* rejected contributes no ids at all, and
            // that is an ordinary page in the middle of anyone's history, not
            // the end of it. Stopping there would silently truncate the import.
            if (page > 0 && repeatedIds > 0 && freshIds === 0) break;

            await sleep(state.paceMs + Math.random() * platform.jitterMs);
        }

        if (unavailable > 0) {
            console.warn(`AlgoPush: ${unavailable} accepted CodeChef submission(s) have no viewable solution and cannot be imported.`);
        }

        return [...newestByProblem.values()].map(row => ({
            indexKey: `CodeChef:${row.problemCode}`,
            // A placeholder: the real title comes from CodeChef's problem API
            // in fetchSubmission below, and from the service worker after that.
            title: row.problemCode,
            row
        }));
    },

    async fetchSubmission(state, entry) {
        const { row } = entry;
        const result = await sendToTab(state.tabId, {
            type: 'CC_HISTORY_SOURCE',
            submissionId: row.id,
            problemCode: row.problemCode,
            contestCode: row.contestCode
        });

        if (!result.code) return result;

        const meta = result.meta || null;
        return {
            submission: {
                type: 'SUBMISSION_ACCEPTED',
                platform: 'CodeChef',
                submissionId: row.id,
                title: (meta && meta.title) || row.problemCode,
                slug: row.problemCode,
                problemCode: row.problemCode,
                contestCode: row.contestCode,
                // The raw rating: the service worker owns the mapping from
                // rating to difficulty band, so every path into the repo files
                // a problem in exactly the same folder.
                difficultyRating: meta ? meta.difficultyRating : null,
                difficulty: 'Unknown',
                tags: (meta && meta.tags) || [],
                code: result.code,
                language: result.language || row.language || 'Unknown',
                // CodeChef names the file extension itself — see the note in
                // content-scripts/codechef.js.
                fileExtension: result.extension || ''
            }
        };
    }
};

document.getElementById('syncHistoryBtn').addEventListener('click', () => runHistoricalImport(codeforcesImport));
document.getElementById('syncLeetCodeHistoryBtn').addEventListener('click', () => runHistoricalImport(leetcodeImport));
document.getElementById('syncAtCoderHistoryBtn').addEventListener('click', () => runHistoricalImport(atcoderImport));
document.getElementById('syncCodeChefHistoryBtn').addEventListener('click', () => runHistoricalImport(codechefImport));

function showStatus(elementId, message, type) {
    const el = document.getElementById(elementId);
    el.textContent = message;
    el.className = `status-msg ${type}`;
    if (type === 'success') {
        setTimeout(() => {
            el.textContent = '';
            el.className = 'status-msg';
        }, 3000);
    }
}
