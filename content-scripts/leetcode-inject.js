// Injected script to intercept LeetCode API requests

const originalFetch = window.fetch;
let lastSubmission = {};

window.fetch = async function(...args) {
    const resource = args[0];
    const url = typeof resource === 'string' ? resource : resource?.url;
    const init = args[1];

    // Intercept submission POST to grab the code and language
    if (url && url.includes('/submit/')) {
        try {
            if (init && init.body) {
                const body = JSON.parse(init.body);
                if (body.typed_code && body.lang) {
                    lastSubmission.code = body.typed_code;
                    lastSubmission.lang = body.lang;
                }
            }
        } catch (e) {
            console.error("AlgoPush: error parsing submit body", e);
        }
    }

    const response = await originalFetch.apply(this, args);

    // After submission, LeetCode returns a submission_id
    if (url && url.includes('/submit/')) {
        const cloned = response.clone();
        cloned.json().then(data => {
            if (data.submission_id) {
                lastSubmission.id = data.submission_id;
            }
        }).catch(() => {});
    }

    // Intercept the check polling endpoint.
    // The check response isn't guaranteed to echo back a `submission_id`
    // field, so relying on `data.submission_id === lastSubmission.id` could
    // silently never fire. The ID is reliably present in the URL itself
    // (".../submissions/detail/<id>/check/"), so we pull it from there.
    if (url && url.includes('/check/')) {
        const idMatch = url.match(/\/submissions\/detail\/(\d+)\/check\//);
        const checkedId = idMatch ? idMatch[1] : null;

        const cloned = response.clone();
        cloned.json().then(data => {
            // Once the status is "Accepted", we notify the content script
            if (data.status_msg === 'Accepted' && checkedId && String(checkedId) === String(lastSubmission.id)) {
                // Targeted at this page's own origin, never '*'. The payload
                // is the user's solution source, and a '*' target delivers it
                // to every third-party frame and script on the page.
                window.postMessage({
                    type: 'LEETCODE_SUBMISSION_ACCEPTED',
                    submissionId: checkedId,
                    code: lastSubmission.code,
                    lang: lastSubmission.lang || data.lang
                }, window.location.origin);
            }
        }).catch(() => {});
    }

    return response;
};
