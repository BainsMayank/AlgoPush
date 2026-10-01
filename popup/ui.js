// Small pieces the board and the friends tab both draw with.

export const FALLBACK_AVATAR = '../images/icon128.png';

export const el = (id) => document.getElementById(id);

export function setStatus(target, message, tone) {
    const node = typeof target === 'string' ? el(target) : target;
    node.textContent = message || '';
    if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
}

export function chip(platform, small) {
    const span = document.createElement('span');
    span.className = small ? 'chip chip--sm' : 'chip';
    span.style.setProperty('--chip', platform.color);
    span.textContent = platform.code;
    return span;
}

export function dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Draws the 28-day pad into `pad` from a set of "YYYY-MM-DD" days, and hands
 * `describe` the number of active days so it can write the aria-label:
 * role="img" collapses the cells into one node, so the label has to carry
 * what a sighted reader gets from the grid. `frozen` holds the days a streak
 * freeze covered.
 */
export function fillPad(pad, days, describe, frozen = new Set()) {
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
        else if (frozen.has(dayKey(date))) cell.dataset.frozen = '1';
        if (date.getTime() === today.getTime()) cell.dataset.today = '1';

        if (date <= today && days.has(dayKey(date))) active += 1;
        pad.appendChild(cell);
    }

    pad.setAttribute('aria-label', describe(active));
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ── DOM building ──────────────────────────────────────────────────── */

export function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}

export function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
}

// Everything below renders what other people typed or uploaded, so links are
// only ever web links and avatars only ever GitHub's.
export function safeHref(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

export function avatar(url, className = 'idrow-avatar') {
    const safe = typeof url === 'string' && url.startsWith('https://avatars.githubusercontent.com/');
    return h('img', { class: className, src: safe ? url : FALLBACK_AVATAR, alt: '' });
}

export function shortDate(day) {
    return new Date(`${day}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
