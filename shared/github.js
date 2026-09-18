/**
 * Shared GitHub API Utilities
 */

function encodeBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Turns an exhausted rate limit into a clear error instead of an opaque 403.
 *
 * Only ever applied to a request that actually failed. GitHub decrements the
 * counter *before* answering, so the request that spends the final unit comes
 * back 200/201 with `X-RateLimit-Remaining: 0` — throwing on that reported a
 * commit that had already landed as a failed sync, left it out of the local
 * index, and queued it to be pushed again.
 */
function checkRateLimit(response) {
    if (response.ok) return;

    const remaining = response.headers.get('X-RateLimit-Remaining');
    if (remaining === null || parseInt(remaining, 10) > 0) return;

    const reset = parseInt(response.headers.get('X-RateLimit-Reset'), 10);
    const resetTime = Number.isFinite(reset)
        ? ` Resets at ${new Date(reset * 1000).toLocaleTimeString()}.`
        : '';
    throw new Error(`GitHub API rate limit exceeded.${resetTime}`);
}

/** Encodes a repo-relative path for a Contents API URL, one segment at a time. */
function encodePath(path) {
    return String(path || '').split('/').map(encodeURIComponent).join('/');
}

/**
 * Pushes a file to a GitHub repository.
 * Creates the file if it doesn't exist, updates it if it does.
 * Skips the push if the remote content is identical.
 */
export async function pushFileToRepo({ token, owner, repo, path, content, commitMessage, branch = 'main' }) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(path)}`;
    const encodedContent = encodeBase64(content);

    let sha = null;
    let existingBase64 = null;

    // 1. GET the file to check if it exists and retrieve its SHA & content
    try {
        const getResponse = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        checkRateLimit(getResponse);

        if (getResponse.status === 401) {
            throw new Error('Authentication failed: Invalid GitHub token.');
        }

        if (getResponse.status === 403) {
            throw new Error("Permission denied (403) while checking the file. Your token may lack 'Contents' read/write access for this repository.");
        }
        
        if (getResponse.status === 404) {
            // File doesn't exist, this is fine, we will create it (sha remains null)
        } else if (!getResponse.ok) {
            throw new Error(`Failed to fetch file info: ${getResponse.statusText}`);
        } else {
            const data = await getResponse.json();
            sha = data.sha;
            existingBase64 = data.content ? data.content.replace(/\n/g, '') : null;
        }
    } catch (error) {
        // Re-throw all errors from this step — previously only auth/rate-limit
        // errors were re-thrown and everything else (403s, network errors,
        // malformed JSON, etc.) was silently swallowed, letting execution
        // continue as if the file simply didn't exist yet.
        throw error;
    }

    // Skip if content is exactly the same (prevents duplicate commits for duplicate submissions)
    if (existingBase64 === encodedContent) {
        console.log(`AlgoPush: File ${path} is identical on remote. Skipping commit.`);
        return { skipped: true };
    }

    // Helper for the PUT request
    const putFile = async (currentSha) => {
        const body = {
            message: commitMessage,
            content: encodedContent,
            branch: branch
        };
        
        if (currentSha) {
            body.sha = currentSha;
        }

        const putResponse = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        checkRateLimit(putResponse);

        if (putResponse.status === 401) {
            throw new Error('Authentication failed: Invalid GitHub token.');
        }
        if (putResponse.status === 403) {
            throw new Error("Permission denied (403). Your token can read this repo but can't write to it — check that your fine-grained PAT has 'Contents: Read and write' access for this repository, or that a classic token has the 'repo' scope.");
        }
        if (putResponse.status === 404) {
            throw new Error(`Repository not found or no write access: ${owner}/${repo}`);
        }
        
        return putResponse;
    };

    // 2. PUT the file
    let putResponse = await putFile(sha);

    // 3. Handle stale SHA conflicts. The Contents API uses 409 in some
    // cases, but also returns 422 with "does not match <sha>" for a changed
    // file, especially README.md. Both cases are safe to retry with a fresh
    // SHA because this operation writes the complete intended content.
    const isStaleShaConflict = async (response) => {
        if (response.status === 409) return true;
        if (response.status !== 422) return false;
        try {
            const conflictData = await response.clone().json();
            return /does not match|sha/i.test(conflictData.message || '');
        } catch (_) {
            return false;
        }
    };

    // A service-worker restart or an overlapping index update can make the
    // refreshed SHA stale again. Retry a few times before reporting a genuine
    // conflict to the caller.
    for (let retry = 0; await isStaleShaConflict(putResponse) && retry < 3; retry++) {
        console.warn(`AlgoPush: ${putResponse.status} stale-SHA conflict detected; refreshing SHA (retry ${retry + 1}/3)...`);
        const freshGetResponse = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        checkRateLimit(freshGetResponse);

        if (freshGetResponse.ok) {
            const freshData = await freshGetResponse.json();
            putResponse = await putFile(freshData.sha);
        } else {
            throw new Error(`Failed to resolve conflict. Could not fetch fresh SHA: ${freshGetResponse.statusText}`);
        }
    }

    if (!putResponse.ok) {
        const errorData = await putResponse.json();
        throw new Error(`GitHub API Error: ${errorData.message}`);
    }

    return putResponse.json();
}

/**
 * Deletes a file from the repository.
 *
 * Used to remove a solution file that a later submission superseded — when a
 * problem is re-solved in a different language the new file has a different
 * extension, so without this the folder accumulates one file per language
 * ever used instead of holding the current solution.
 *
 * Deliberately forgiving: a file that is already gone (404) is success, and
 * every other failure is reported to the caller to log rather than thrown at
 * the user, because the replacement has by then already been committed and
 * the sync itself did succeed.
 */
export async function deleteFileFromRepo({ token, owner, repo, path, commitMessage, branch = 'main' }) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(path)}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };

    const getResponse = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { method: 'GET', headers });
    checkRateLimit(getResponse);

    if (getResponse.status === 404) return { skipped: true };
    if (!getResponse.ok) {
        throw new Error(`Could not look up ${path} for deletion (HTTP ${getResponse.status}).`);
    }

    const { sha } = await getResponse.json();

    const deleteResponse = await fetch(url, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMessage, sha, branch })
    });
    checkRateLimit(deleteResponse);

    // Someone else changed it in between; leaving it in place is harmless.
    if (deleteResponse.status === 409 || deleteResponse.status === 422) {
        return { skipped: true };
    }
    if (!deleteResponse.ok) {
        throw new Error(`Could not delete ${path} (HTTP ${deleteResponse.status}).`);
    }
    return { deleted: true };
}

/**
 * Tests the connection to the GitHub repository and verifies push access.
 */
export async function testConnection(token, owner, repo) {
    const url = `https://api.github.com/repos/${owner}/${repo}`;
    
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    checkRateLimit(response);

    if (response.status === 401) {
        throw new Error('Authentication failed: Invalid GitHub token.');
    }
    if (response.status === 404) {
        throw new Error(`Repository not found or no access: ${owner}/${repo}`);
    }
    if (!response.ok) {
        throw new Error(`Failed to connect: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Check if the token has push access to the repository
    if (!data.permissions || !data.permissions.push) {
        throw new Error('Token does not have push access to this repository.');
    }

    return true;
}

/**
 * Resolves the branch that receives commits.  An omitted branch intentionally
 * means the repository's default branch instead of assuming it is named
 * "main" (many existing solution repositories still use "master").
 */
export async function resolveBranch(token, owner, repo, configuredBranch = '') {
    const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    const repoResponse = await fetch(repoUrl, { headers });
    checkRateLimit(repoResponse);

    if (repoResponse.status === 401) throw new Error('Authentication failed: Invalid GitHub token.');
    if (repoResponse.status === 404) throw new Error(`Repository not found or no access: ${owner}/${repo}`);
    if (!repoResponse.ok) throw new Error(`Failed to inspect repository: ${repoResponse.statusText}`);

    const repository = await repoResponse.json();
    const branch = configuredBranch.trim() || repository.default_branch;
    if (!branch) {
        throw new Error('This repository has no default branch yet. Create an initial commit on GitHub, then try again.');
    }

    const refResponse = await fetch(
        // encodePath, not encodeURIComponent: a branch like "feature/x" is a
        // multi-segment ref, and escaping its slash asks for a branch that
        // literally has "%2F" in the name.
        `${repoUrl}/git/ref/heads/${encodePath(branch)}`,
        { headers }
    );
    checkRateLimit(refResponse);
    if (refResponse.status === 404) {
        // Older versions prefilled "main" even when the repository's default
        // branch was "master". Preserve an explicitly chosen branch, but
        // repair that legacy default automatically.
        if (branch === 'main' && repository.default_branch && repository.default_branch !== 'main') {
            console.warn(`AlgoPush: branch "main" was not found; using repository default branch "${repository.default_branch}".`);
            return repository.default_branch;
        }
        throw new Error(`Branch "${branch}" does not exist. Set Branch to an existing branch (for example "${repository.default_branch || 'main'}").`);
    }
    if (!refResponse.ok) throw new Error(`Failed to verify branch "${branch}": ${refResponse.statusText}`);

    return branch;
}
