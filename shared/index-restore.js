import { parseProblemUrl } from './problem-url.js';

// Rebuilding syncedProblemsIndex after it was lost — a reinstall, a new
// browser profile, a cleared extension — from the two places that outlive the
// extension: the root README.md AlgoPush keeps in the user's own repository,
// and, for anyone with a profile, the solves they shared with friends.
//
// Without this, an emptied index is more than a blank board: the next live
// sync rewrites the root README from the index, which would replace an index
// of hundreds of problems with a single row.

const PLATFORMS = new Set(['LeetCode', 'Codeforces', 'AtCoder', 'CodeChef']);

function unescapeCell(value) {
    return value.replace(/\\([|[\]])/g, '$1').trim();
}

function decodeUrl(value) {
    try {
        return decodeURI(value);
    } catch {
        return value;
    }
}

function splitRow(line) {
    // Cells are separated by pipes that are not escaped as "\|".
    return line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
}

// The URL runs to the cell's last ")": encodeURI leaves parentheses alone,
// and a folder named "Sum (II)" keeps them.
const LINKED = /^\[((?:\\.|[^\]\\])*)\]\((.*)\)$/;

/**
 * Reads the root README's tables back into index entries, keyed the way the
 * sync path keys them. Returns `{ [key]: entry }`; rows it cannot read are
 * skipped rather than guessed at.
 */
export function parseRootReadme(markdown) {
    const out = {};
    let platform = null;
    let tag = null;

    for (const raw of String(markdown || '').split(/\r?\n/)) {
        const line = raw.trim();

        const heading = /^###\s+([^:]+):\s+(.+)$/.exec(line);
        if (heading) {
            platform = PLATFORMS.has(heading[1].trim()) ? heading[1].trim() : null;
            tag = heading[2].trim();
            continue;
        }
        if (/^##\s/.test(line)) {
            platform = null;
            continue;
        }
        if (!platform || !line.startsWith('|')) continue;

        const cells = splitRow(line);
        if (cells.length !== 4) continue;
        const problem = LINKED.exec(cells[0]);
        const solution = LINKED.exec(cells[2]);
        const date = cells[3];
        if (!problem || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

        const title = unescapeCell(problem[1]);
        const link = decodeUrl(problem[2]) || null;
        const folderUrl = solution ? decodeUrl(solution[2]) || null : null;
        if (!title) continue;

        const parsed = link ? parseProblemUrl(link) : null;
        let key = parsed && parsed.platform === platform ? parsed.key : null;
        if (!key && folderUrl) {
            // No recognisable problem link: the folder still names the problem
            // uniquely within this repository.
            const folder = folderUrl.split('/').filter(Boolean).pop();
            if (folder) key = `${platform}:${folder}`;
        }
        if (!key) continue;

        const entry = out[key] || {
            title,
            platform,
            difficulty: unescapeCell(cells[1]) || 'Unknown',
            tags: [],
            link,
            folderUrl,
            date,
            solvedAt: null
        };
        if (tag && tag !== 'Uncategorized' && !entry.tags.includes(tag)) entry.tags.push(tag);
        out[key] = entry;
    }
    return out;
}

/** An entry for the index from one solve the friends service returns. */
export function entryFromShared(solve) {
    return {
        title: solve.title,
        platform: solve.platform,
        difficulty: solve.difficulty || 'Unknown',
        tags: [],
        link: solve.link || null,
        folderUrl: solve.solutionUrl || null,
        date: solve.solvedOn,
        solvedAt: Number.isInteger(solve.solvedAt) ? solve.solvedAt : null
    };
}

const norm = (url) => (url ? decodeUrl(String(url)).replace(/\/+$/, '').toLowerCase() : null);

/**
 * Adds `incoming` entries to `index` in place. A problem already on record —
 * matched by key, solution folder or problem link — keeps every field it has
 * and only gains the ones it was missing. Returns how many were added.
 */
export function mergeIntoIndex(index, incoming) {
    const byFolder = new Map();
    const byLink = new Map();
    for (const [key, entry] of Object.entries(index)) {
        if (!entry) continue;
        if (entry.folderUrl) byFolder.set(norm(entry.folderUrl), key);
        if (entry.link) byLink.set(`${entry.platform}|${norm(entry.link)}`, key);
    }

    let added = 0;
    for (const [key, entry] of Object.entries(incoming)) {
        if (!entry || !entry.title || !entry.date || !PLATFORMS.has(entry.platform)) continue;

        const existingKey = index[key] ? key
            : (entry.folderUrl && byFolder.get(norm(entry.folderUrl)))
            || (entry.link && byLink.get(`${entry.platform}|${norm(entry.link)}`));

        if (existingKey) {
            const existing = index[existingKey];
            if ((!existing.tags || existing.tags.length === 0) && entry.tags && entry.tags.length) existing.tags = entry.tags;
            if ((!existing.difficulty || existing.difficulty === 'Unknown') && entry.difficulty) existing.difficulty = entry.difficulty;
            if (!Number.isInteger(existing.solvedAt) && Number.isInteger(entry.solvedAt)) existing.solvedAt = entry.solvedAt;
            if (!existing.folderUrl && entry.folderUrl) existing.folderUrl = entry.folderUrl;
            if (!existing.link && entry.link) existing.link = entry.link;
            continue;
        }

        index[key] = { ...entry, tags: entry.tags || [] };
        if (entry.folderUrl) byFolder.set(norm(entry.folderUrl), key);
        if (entry.link) byLink.set(`${entry.platform}|${norm(entry.link)}`, key);
        added += 1;
    }
    return added;
}
