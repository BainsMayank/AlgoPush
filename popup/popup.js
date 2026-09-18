import { testConnection } from '../shared/github.js';
import { getEffectiveGithubToken } from '../shared/github-auth.js';

document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('settingsBtn').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // Previously "Force Sync Now" just relabeled itself for 2 seconds and did
    // nothing — misleading, since there was no actual sync action behind it.
    // Syncing is event-driven (fires the moment a judge confirms Accepted),
    // so this button now does something real: re-check connection + history.
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        const btn = document.getElementById('refreshBtn');
        btn.disabled = true;
        btn.textContent = 'Refreshing...';
        await loadHistory();
        await checkConnection();
        await loadLastError();
        btn.textContent = 'Refresh Status';
        btn.disabled = false;
    });

    // Bound once. loadLastError() runs on open *and* on every Refresh, so
    // registering the handler in there stacked a fresh listener each time.
    document.getElementById('dismissErrorBtn').addEventListener('click', async () => {
        await chrome.storage.local.remove('lastError');
        document.getElementById('errorBanner').style.display = 'none';
    });

    await loadHistory();
    await checkConnection();
    await loadLastError();
});

async function loadLastError() {
    const { lastError } = await chrome.storage.local.get('lastError');
    const banner = document.getElementById('errorBanner');
    if (!lastError) {
        banner.style.display = 'none';
        return;
    }
    document.getElementById('errorBannerText').textContent = `Last sync failed (${lastError.title}): ${lastError.message}`;
    banner.style.display = 'flex';
}

async function loadHistory() {
    const { syncHistory = [] } = await chrome.storage.local.get('syncHistory');
    const list = document.getElementById('historyList');
    
    if (syncHistory.length === 0) {
        list.innerHTML = '<li class="empty-state">No recent syncs found.</li>';
        return;
    }

    list.innerHTML = '';
    const recent = syncHistory.slice(0, 5);
    
    recent.forEach(item => {
        const li = document.createElement('li');
        const time = new Date(item.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        const spanPlat = document.createElement('span');
        spanPlat.className = `platform-badge ${item.platform.toLowerCase()}`;
        spanPlat.textContent = item.platform;

        const spanTitle = document.createElement('span');
        spanTitle.className = 'title';
        spanTitle.textContent = item.title;

        const spanTime = document.createElement('span');
        spanTime.className = 'time';
        spanTime.textContent = time;

        li.appendChild(spanPlat);
        li.appendChild(spanTitle);
        li.appendChild(spanTime);
        list.appendChild(li);
    });
}

async function checkConnection() {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('connectionStatus');
    
    // Resolve through the shared helper rather than reading `githubToken`
    // directly: one-click GitHub App users only have `githubOauthToken`, and
    // reading the legacy key made a working setup look unconfigured.
    const token = await getEffectiveGithubToken();
    const { githubRepo } = await chrome.storage.local.get('githubRepo');

    if (!token || !githubRepo) {
        statusDot.className = 'status-indicator error';
        statusText.textContent = 'Not configured. Please open settings.';
        return;
    }

    const parts = githubRepo.split('/');
    if (parts.length !== 2) {
        statusDot.className = 'status-indicator error';
        statusText.textContent = 'Invalid repo format.';
        return;
    }

    try {
        await testConnection(token, parts[0], parts[1]);
        statusDot.className = 'status-indicator success';
        statusText.textContent = `Connected to ${githubRepo}`;
    } catch (e) {
        statusDot.className = 'status-indicator error';
        statusText.textContent = 'Connection failed.';
    }
}
