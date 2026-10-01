// Injected into the page's own world to watch LeetCode's submit flow.
//
// Two signals go to the content script, and it acts on whichever proves the
// verdict first:
//
//   LEETCODE_SUBMITTED            the submit endpoint answered with an id. The
//                                 content script then asks LeetCode's GraphQL
//                                 for that submission's verdict — the same API
//                                 the historical import relies on, and one that
//                                 does not care how the page polls for results.
//   LEETCODE_SUBMISSION_ACCEPTED  the page's own result poll said Accepted.
//
// The second alone used to be the whole mechanism, and it broke silently when
// LeetCode moved result polling to `/submissions/detail/<id>/v2/check/` with
// a different response shape. Keeping both means the next such change costs
// a few seconds of latency instead of every live sync.

const originalFetch = window.fetch;

const SUBMIT_PATTERN = /\/submit\/?(?:\?|$)/;
// v1 is `/submissions/detail/<id>/check/`, v2 inserts `/v2`; accept any version.
const CHECK_PATTERN = /\/submissions\/detail\/(\d+)\/(?:v\d+\/)?check\/?(?:\?|$)/;
// LeetCode's status code for Accepted, in both result shapes and in GraphQL.
const ACCEPTED_STATUS_CODE = 10;

// The source each submission was made with, keyed by its id once the submit
// endpoint names it. Keyed rather than "last one", so two quick submits can
// never have one's code pushed under the other's verdict.
const sources = new Map();
let draft = null;

function post(message) {
    // Targeted at this page's own origin, never '*': the payload is the
    // user's solution source, and '*' delivers it to every frame on the page.
    window.postMessage(message, window.location.origin);
}

function urlOf(resource) {
    if (typeof resource === 'string') return resource;
    if (resource instanceof URL) return resource.href;
    return resource && resource.url;
}

function isAccepted(result) {
    if (!result || typeof result !== 'object') return false;
    if (result.status_msg === 'Accepted') return true;
    // v2 reports progress in `state` and the verdict in `status_code`.
    const finished = result.state === undefined || result.state === 'SUCCESS';
    return finished && Number(result.status_code) === ACCEPTED_STATUS_CODE;
}

window.fetch = async function (...args) {
    const url = urlOf(args[0]) || '';
    const init = args[1];
    const path = url.replace(/^https?:\/\/[^/]+/, '');

    const isSubmit = SUBMIT_PATTERN.test(path) && (!init || !init.method || init.method.toUpperCase() === 'POST');
    if (isSubmit && init && typeof init.body === 'string') {
        try {
            const body = JSON.parse(init.body);
            if (body.typed_code && body.lang) draft = { code: body.typed_code, lang: body.lang };
        } catch (e) {
            console.error('AlgoPush: could not read the LeetCode submit body', e);
        }
    }

    const response = await originalFetch.apply(this, args);

    if (isSubmit) {
        const submitted = draft;
        draft = null;
        response.clone().json().then((data) => {
            if (!data || !data.submission_id) return;
            const submissionId = String(data.submission_id);
            if (submitted) sources.set(submissionId, submitted);
            post({
                type: 'LEETCODE_SUBMITTED',
                submissionId,
                code: submitted && submitted.code,
                lang: submitted && submitted.lang
            });
        }).catch(() => {});
    }

    const check = CHECK_PATTERN.exec(path);
    if (check) {
        const submissionId = check[1];
        response.clone().json().then((data) => {
            // Only a submission this page made — "Run" polls the same
            // endpoint with ids that were never submitted.
            if (!sources.has(submissionId) || !isAccepted(data)) return;
            const { code, lang } = sources.get(submissionId);
            post({ type: 'LEETCODE_SUBMISSION_ACCEPTED', submissionId, code, lang: lang || data.lang });
        }).catch(() => {});
    }

    return response;
};
