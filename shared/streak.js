// One definition of a run, shared by the popup, the service worker and the
// friends service (social-backend bundles this file), so a streak reads the
// same number everywhere it is shown.
//
// Days are day numbers: whole days since 1970-01-01, taken from the
// extension's own "YYYY-MM-DD" local-day strings. Nothing here knows about
// time zones; the caller decides which calendar day "today" is.
//
// Freezes: every FREEZE_EVERY solved days in a run earn one freeze, up to
// FREEZE_MAX held at once. A finished day with no solve spends one instead of
// ending the run. The run does not grow on a frozen day — a freeze keeps a
// run, it does not pad it. Everything is derived from the solved days alone,
// so there is no inventory to store, sync or lose with a reinstall.

export const FREEZE_EVERY = 7;
export const FREEZE_MAX = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

// The local calendar day, the unit every streak is counted in.
export function localDay(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dayNumber(day) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
    return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

export function dayString(n) {
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** Day numbers from any iterable of "YYYY-MM-DD" strings, skipping junk. */
export function dayNumbers(days) {
    const out = new Set();
    for (const day of days) {
        const n = dayNumber(day);
        if (Number.isFinite(n)) out.add(n);
    }
    return out;
}

/**
 * Walks every day from the first solve to `today` and returns
 * `{ run, activeToday, freezes, frozen, longest }`:
 *
 * - `run`: the current run. Today not being over yet never breaks it.
 * - `freezes`: freezes held right now.
 * - `frozen`: the set of day numbers a freeze covered, in any run.
 * - `longest`: the longest run ever, counted the same way.
 * - `nextFreezeIn`: solved days until the next freeze, null when full.
 */
export function computeRun(days, today) {
    const result = { run: 0, activeToday: days.has(today), freezes: 0, frozen: new Set(), longest: 0, nextFreezeIn: FREEZE_EVERY };
    if (days.size === 0) return result;

    let first = Infinity;
    for (const day of days) if (day < first) first = day;

    let run = 0;
    let freezes = 0;
    let towardFreeze = 0;
    let longest = 0;

    for (let day = first; day <= today; day += 1) {
        if (days.has(day)) {
            run += 1;
            towardFreeze += 1;
            if (towardFreeze === FREEZE_EVERY) {
                towardFreeze = 0;
                if (freezes < FREEZE_MAX) freezes += 1;
            }
        } else if (day === today) {
            // Still time to solve.
        } else if (run > 0 && freezes > 0) {
            freezes -= 1;
            result.frozen.add(day);
        } else {
            run = 0;
            towardFreeze = 0;
            freezes = 0;
        }
        if (run > longest) longest = run;
    }

    result.run = run;
    result.freezes = freezes;
    result.longest = longest;
    // Solved days still needed for the next freeze; null while the hold is full.
    result.nextFreezeIn = freezes >= FREEZE_MAX ? null : FREEZE_EVERY - towardFreeze;
    return result;
}

/** Monday of the week holding `day`, as a day number. Day 0 was a Thursday. */
export function weekStart(day) {
    return day - ((day + 3) % 7);
}
