import { computeRun, dayNumbers, dayNumber, localDay } from './streak.js';

// Marks along the way, worked out from syncedProblemsIndex like everything
// else on the board — nothing new is stored but the list already announced.

export const SOLVE_MARKS = [10, 25, 50, 100, 250, 500, 1000, 2000];
export const RUN_MARKS = [7, 14, 30, 60, 100, 200, 365];

// Ids of milestones already announced, so each is announced once.
export const MILESTONES_SEEN_KEY = 'milestonesSeen';

const solveId = (n) => `solves-${n}`;
const runId = (n) => `run-${n}`;

/**
 * What the index has reached: `{ total, run, longest, earned, next }`.
 * `earned` lists every milestone reached, oldest kind first; `next` holds the
 * nearest unreached mark of each kind, or null past the last one.
 */
export function milestonesFor(index, today = dayNumber(localDay())) {
    const entries = Object.values(index || {}).filter((entry) => entry && entry.date);
    const total = entries.length;
    const { run, longest } = computeRun(dayNumbers(entries.map((entry) => entry.date)), today);

    const earned = [
        ...SOLVE_MARKS.filter((n) => total >= n).map((n) => ({ id: solveId(n), kind: 'solves', value: n, label: `${n.toLocaleString()} solves` })),
        ...RUN_MARKS.filter((n) => longest >= n).map((n) => ({ id: runId(n), kind: 'run', value: n, label: `${n}-day run` }))
    ];

    const nextSolve = SOLVE_MARKS.find((n) => total < n);
    const nextRun = RUN_MARKS.find((n) => longest < n);
    return {
        total,
        run,
        longest,
        earned,
        next: {
            solves: nextSolve ? { value: nextSolve, left: nextSolve - total } : null,
            run: nextRun ? { value: nextRun, left: nextRun - run } : null
        }
    };
}

/**
 * Milestones earned since the last call, highest first, and records them as
 * seen. The first call on an install records everything silently: a restored
 * or imported history is not a fresh achievement.
 */
export async function takeNewMilestones(index) {
    const { [MILESTONES_SEEN_KEY]: seen } = await chrome.storage.local.get(MILESTONES_SEEN_KEY);
    const { earned } = milestonesFor(index);
    const ids = earned.map((m) => m.id);

    if (!Array.isArray(seen)) {
        await chrome.storage.local.set({ [MILESTONES_SEEN_KEY]: ids });
        return [];
    }

    const fresh = earned.filter((m) => !seen.includes(m.id));
    if (fresh.length) await chrome.storage.local.set({ [MILESTONES_SEEN_KEY]: [...new Set([...seen, ...ids])] });
    return fresh.sort((a, b) => b.value - a.value);
}
