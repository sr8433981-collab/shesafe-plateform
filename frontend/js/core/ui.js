/**
 * Shared UI kit.
 *
 * One place for the things that were previously duplicated five times:
 *
 *   * **Icons** — inline SVG, 24x24, `currentColor`, `aria-hidden` unless a
 *     label is supplied. Replaces the emoji iconography, which rendered
 *     differently on every platform and could not inherit colour.
 *   * **Status vocabulary** — one `TONE` table maps a semantic tone to a badge
 *     class and an icon. Previously there were five separate class tables
 *     five per-module badge tables, and HIGH risk looked identical to
 *     MODERATE.
 *   * **`metric()` / `timeline()`** — defined once, used everywhere.
 *   * **`loadInto()`** — skeleton -> content, or error state with a retry.
 *   * **Sheets** — accessible confirm/prompt/action dialogs that replace
 *     `window.confirm`, `window.prompt` and `window.alert`.
 */

import { $, el, mount } from './dom.js';

/* ------------------------------------------------------------------ icons */

const ICONS = {
  shield: 'M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3z',
  shieldCheck: 'M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3zM9 12l2 2 4-4',
  siren: 'M7 18v-5a5 5 0 0110 0v5M4 18h16M5 21h14M12 3v2',
  phone: 'M5 4h3l2 5-2 1a11 11 0 005 5l1-2 5 2v3a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z',
  pin: 'M12 21s7-5.6 7-11a7 7 0 10-14 0c0 5.4 7 11 7 11z M12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  gauge: 'M12 14l4-4M4.5 18a8.5 8.5 0 1115 0M12 20h.01',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  users: 'M16 20v-1.5a4 4 0 00-4-4H7a4 4 0 00-4 4V20M9.5 10.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1.5a4 4 0 00-3-3.87M16 3.6a4 4 0 010 7.75',
  community: 'M3 11l9-7 9 7M5 10v10h14V10M9 20v-6h6v6',
  route: 'M6.5 8.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM17.5 20.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM6.5 8.5v4a4 4 0 004 4h3a4 4 0 014 4',
  archive: 'M3 7h18v4H3zM5 11v9h14v-9M10 15h4',
  lock: 'M6 11h12v9H6zM9 11V7.5a3 3 0 016 0V11M12 15v2',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M4.5 12.5l5 5 10-11',
  checkCircle: 'M12 21a9 9 0 100-18 9 9 0 000 18zM8.5 12.2l2.4 2.4 4.6-5',
  alert: 'M12 3.5L21.5 20h-19L12 3.5zM12 10v4M12 17h.01',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01',
  wifiOff: 'M2 3l20 20M8.5 16.5a5 5 0 017 0M5 12.5a10 10 0 014-2.4M19 12.5a10 10 0 00-4-2.4M2.5 8.5A15 15 0 015 6M21.5 8.5A15 15 0 0012 5c-1.2 0-2.3.2-3.4.5M12 20h.01',
  copy: 'M9 9h10v11H9zM5 15H4V4h11v1',
  message: 'M21 12a8 8 0 01-11.6 7.1L4 21l1.9-5.4A8 8 0 1121 12z',
  arrowRight: 'M4 12h16M14 6l6 6-6 6',
  chevronRight: 'M9 5l7 7-7 7',
  arrowLeft: 'M20 12H4M10 6l-6 6 6 6',
  arrowUp: 'M12 20V5M6 11l6-6 6 6',
  arrowDown: 'M12 4v15M6 13l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  pencil: 'M4 20h4L20 8l-4-4L4 16v4z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  pause: 'M9 5v14M15 5v14',
  star: 'M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3.5z',
  mic: 'M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3zM5 11a7 7 0 0014 0M12 18v3',
  volume: 'M4 9v6h4l5 4V5L8 9H4zM17 9.5a3.5 3.5 0 010 5M19.5 7a7 7 0 010 10',
  mute: 'M4 9v6h4l5 4V5L8 9H4zM17 10l4 4M21 10l-4 4',
  battery: 'M3 8h15v8H3zM21 11v2M6 11v2',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16a4 4 0 100-8 4 4 0 000 8zM12 13a1 1 0 100-2 1 1 0 000 2z',
  navigate: 'M12 21l7-17-7 4-7-4 7 17z',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  refresh: 'M20 12a8 8 0 11-2.3-5.6M20 4v4h-4',
  download: 'M12 4v11M8 11l4 4 4-4M4 19h16',
  key: 'M15.5 3a5.5 5.5 0 00-4.7 8.3L3 19v2h3v-2h2v-2h2l1.3-1.3A5.5 5.5 0 1015.5 3zM17 7h.01',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  building: 'M4 21V6l7-3v18M11 21h9V10l-9-3M7 9v.01M7 13v.01M7 17v.01M15 13v.01M15 17v.01',
  hospital: 'M4 21V8l8-4 8 4v13M12 10v6M9 13h6',
  pill: 'M8.5 3.5a5 5 0 017 7l-5 5a5 5 0 01-7-7l5-5zM6 6l7 7',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4v-9z',
  play: 'M7 4.5l12 7.5-12 7.5v-15z',
  logOut: 'M14 20H6V4h8M17 8l4 4-4 4M9 12h12',
  settings: 'M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 13a7.6 7.6 0 000-2l2-1.5-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1L15 3H9l-.3 2.6c-.6.3-1.2.6-1.7 1l-2.4-1-2 3.4L4.6 11a7.6 7.6 0 000 2l-2 1.5 2 3.4 2.4-1c.5.4 1.1.7 1.7 1L9 21h6l.3-2.6c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.5z',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  hourglass: 'M7 3h10v4l-5 5 5 5v4H7v-4l5-5-5-5V3z',
  scale: 'M12 4v16M6 8l-3 6h6L6 8zM18 8l-3 6h6l-3-6zM5 8h14',
};

/**
 * Build an inline SVG icon.
 * @param {keyof typeof ICONS} name
 * @param {{label?: string, width?: number}} [options]
 */
export function icon(name, { label = null, width = null } = {}) {
  const d = ICONS[name] || ICONS.info;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', label ? null : 'true');
  svg.setAttribute('role', label ? 'img' : null);
  if (label) svg.setAttribute('aria-label', label);
  if (width) { svg.setAttribute('width', String(width)); svg.setAttribute('height', String(width)); }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

/* ------------------------------------------------------------------ tones */

/**
 * The single status vocabulary.
 *
 * `tone` is semantic. Nothing in the application invents a badge class; it asks
 * for a tone and gets the class, the icon and the accessible wording.
 */
export const TONE = {
  brand:   { badge: 'badge--brand',   icon: 'shieldCheck', word: 'Available' },
  safe:    { badge: 'badge--safe',    icon: 'checkCircle', word: 'Safe' },
  caution: { badge: 'badge--caution', icon: 'alert',       word: 'Caution' },
  high:    { badge: 'badge--high',    icon: 'alert',       word: 'High' },
  danger:  { badge: 'badge--danger',  icon: 'siren',       word: 'Emergency' },
  info:    { badge: 'badge--info',    icon: 'info',        word: 'Information' },
  neutral: { badge: 'badge--neutral', icon: 'info',        word: 'Not set' },
  simulated: { badge: 'badge--simulated', icon: 'alert',   word: 'Simulated' },
};

/** Risk band -> tone. HIGH and MODERATE are deliberately distinct. */
export const BAND_TONE = { LOW: 'safe', MODERATE: 'caution', HIGH: 'high', CRITICAL: 'danger' };

/** Notification delivery status -> tone + human word. Never "sent" without proof. */
export const DELIVERY_TONE = {
  sent:        { tone: 'safe',    word: 'DELIVERED' },
  simulated:   { tone: 'simulated', word: 'SIMULATED' },
  failed:      { tone: 'danger',  word: 'FAILED' },
  unavailable: { tone: 'neutral', word: 'UNAVAILABLE' },
  skipped:     { tone: 'neutral', word: 'SKIPPED' },
};

/** A status pill. Always carries a word, never colour alone. */
export function pill(label, tone = 'neutral', { dot = false, live = false, iconName = null } = {}) {
  const spec = TONE[tone] || TONE.neutral;
  const node = el('span', { class: `badge ${spec.badge}` }, label);
  if (dot || live) node.appendChild(el('span', { class: `dot${live ? ' dot--live' : ''}`, 'aria-hidden': 'true' }));
  if (iconName) node.insertBefore(icon(iconName), node.firstChild);
  return node;
}

/* --------------------------------------------------------------- building */

export function metric(label, value, { unit = null, tone = null, hint = null } = {}) {
  const valueNode = el('div', { class: `metric__value${tone ? ` metric__value--${tone}` : ''}` }, String(value));
  if (unit) valueNode.appendChild(el('small', {}, ` ${unit}`));
  return el(
    'div',
    { class: 'metric', title: hint || undefined },
    el('div', { class: 'metric__label' }, label),
    valueNode,
  );
}

export function metricGrid(items) {
  return el('div', { class: 'metric-grid' }, ...items.filter(Boolean));
}

export function card(title, { hint = null, action = null, body = [], tone = null, flush = false } = {}) {
  const head = title || action
    ? el('div', { class: 'card__head' },
        title ? el('div', {}, el('h3', { class: 'card__title' }, title), hint ? el('p', { class: 'card__hint' }, hint) : null) : null,
        action || null)
    : null;
  const classes = ['card'];
  if (tone) classes.push(`card--${tone}`);
  if (flush) classes.push('card--flush');
  return el('section', { class: classes.join(' ') }, head, ...[].concat(body).filter(Boolean));
}

export function dataRow({ iconName = 'info', title, meta = null, badges = [], actions = null, body = null }) {
  return el(
    'li',
    { class: 'dlist__item' },
    el('div', { class: 'dlist__icon', 'aria-hidden': 'true' }, icon(iconName)),
    el('div', { class: 'dlist__body' },
      el('div', { class: 'dlist__title' }, title, ...badges.filter(Boolean)),
      meta ? el('div', { class: 'dlist__meta' }, meta) : null,
      body || null),
    actions ? el('div', { class: 'dlist__actions' }, ...[].concat(actions).filter(Boolean)) : null,
  );
}

export function dataList(rows, { className = '' } = {}) {
  return el('ul', { class: `dlist ${className}`.trim() }, ...[].concat(rows).filter(Boolean));
}

/* --------------------------------------------------------------- timeline */

/**
 * The Safety Timeline.
 *
 * One component, used by the emergency console, incident history, Journey Guard
 * and the guardian console. It renders the four facts every event in this product
 * must carry: **timestamp, event type, status, and a human-readable
 * explanation**.
 *
 * The vocabulary mirrors `backend/app/timeline.py` exactly, so the wording on
 * screen is the wording the server generated. A raw lifecycle entry (the older
 * `{state, detail, at}` shape) is still accepted and mapped through the state
 * tables below, so no existing call site has to change shape.
 */

/** Status -> tone. Colour is never the only cue: the word is always shown. */
export const STATUS_TONE = {
  delivered: 'safe',
  closed: 'safe',
  active: 'danger',
  failed: 'danger',
  pending: 'caution',
  simulated: 'simulated',
  unavailable: 'neutral',
  skipped: 'neutral',
  cancelled: 'neutral',
};

/** Event type -> the icon that represents it. */
export const TYPE_ICON = {
  sos: 'siren',
  location: 'target',
  sharing: 'pin',
  notification: 'message',
  journey: 'navigate',
  checkin: 'checkCircle',
  route: 'route',
  community: 'community',
};

/** Event type -> the word printed next to the status. */
export const TYPE_LABEL = {
  sos: 'Emergency',
  location: 'Location',
  sharing: 'Sharing',
  notification: 'Contact alert',
  journey: 'Journey Guard',
  checkin: 'Check-in',
  route: 'Route',
  community: 'Community',
};

/** Legacy state-only rows, mapped into the same shape. */
const STATE_TYPE = {
  ARMING: 'sos', COUNTDOWN: 'sos', ACTIVE: 'sos', ESCALATING: 'sos',
  RESOLVED: 'sos', CANCELLED: 'sos',
  ON_JOURNEY: 'journey', CHECK_IN_REQUIRED: 'journey', WARNING: 'journey',
  EMERGENCY: 'sos', ARRIVED: 'checkin',
  UNDER_REVIEW: 'community', VERIFIED: 'community', DISMISSED: 'community',
  RESOLVED_REPORT: 'community',
};

const STATE_STATUS = {
  ARMING: 'active', COUNTDOWN: 'active', ACTIVE: 'active', ESCALATING: 'active',
  RESOLVED: 'closed', CANCELLED: 'cancelled',
  ON_JOURNEY: 'active', CHECK_IN_REQUIRED: 'pending', WARNING: 'failed',
  EMERGENCY: 'active', ARRIVED: 'closed',
  UNDER_REVIEW: 'pending', VERIFIED: 'closed', DISMISSED: 'cancelled',
  RESOLVED_REPORT: 'closed',
};

const STATE_WORD = {
  ARMING: 'SOS arming', COUNTDOWN: 'Cancel window open', ACTIVE: 'SOS activated',
  ESCALATING: 'Escalating', RESOLVED: 'Stood down safely', CANCELLED: 'Cancelled',
  ARRIVED: 'Checked in safely', ON_JOURNEY: 'Journey started',
  CHECK_IN_REQUIRED: 'Check-in due', WARNING: 'No check-in received',
  EMERGENCY: 'Escalated to SOS', UNDER_REVIEW: 'Under review',
  VERIFIED: 'Verified', DISMISSED: 'Dismissed',
};

/** Normalise either event shape into the four facts. */
export function normalizeEvent(entry) {
  if (!entry) return null;
  const state = entry.state || entry.toState || null;
  return {
    at: entry.at || null,
    state,
    type: entry.type || STATE_TYPE[state] || 'sos',
    status: entry.status || STATE_STATUS[state] || 'active',
    label: entry.label || entry.step || STATE_WORD[state] || state || 'Event',
    explanation: entry.explanation || entry.detail || entry.step || STATE_WORD[state] || state || '',
    actor: entry.actor || null,
  };
}

/**
 * Render a Safety Timeline.
 *
 * @param {Array} events entries in the shared shape, or legacy `{state, detail, at}`
 * @param {{showTypes?: boolean, emptyText?: string, clock?: (at: string) => string}} [options]
 */
export function safetyTimeline(events, { showTypes = true, emptyText = 'Nothing has happened yet.', clock = null } = {}) {
  const list = [].concat(events || []).map(normalizeEvent).filter(Boolean);
  if (!list.length) return el('p', { class: 'small' }, emptyText);
  const stamp = clock || ((at) => {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  return el(
    'ol',
    { class: 'timeline', dataset: { component: 'safety-timeline' } },
    ...list.map((entry) => el(
      'li',
      {
        class: 'timeline__item',
        dataset: { type: entry.type, status: entry.status, tone: STATUS_TONE[entry.status] || 'brand' },
      },
      el('span', { class: 'timeline__dot', 'aria-hidden': 'true' }, icon(TYPE_ICON[entry.type] || 'info')),
      el('div', { class: 'timeline__body' },
        el('div', { class: 'timeline__head' },
          el('span', { class: 'timeline__state' }, entry.label),
          entry.at ? el('time', { class: 'timeline__time', datetime: entry.at }, stamp(entry.at)) : null,
          showTypes ? el('span', { class: 'timeline__type' }, TYPE_LABEL[entry.type] || entry.type) : null),
        el('p', { class: 'timeline__meta' }, entry.explanation)),
    )),
  );
}

/** Backwards-compatible alias for the state-only rows the dashboard still sends. */
export function timeline(events, options = {}) {
  return safetyTimeline(events, { showTypes: false, ...options });
}

export function disclosure(summaryText, body, { open = false } = {}) {
  return el('details', { class: 'disclosure', open: open || null }, el('summary', {}, summaryText), el('div', { class: 'disclosure__body' }, body));
}

export function skeletonList(rows = 3, { tall = false } = {}) {
  return el('div', { class: 'stack stack--tight', 'aria-hidden': 'true', role: 'status' },
    el('span', { class: 'sr-only' }, 'Loading…'),
    ...Array.from({ length: rows }, () => el('div', { class: `skeleton ${tall ? 'skeleton--tall' : 'skeleton--row'}` })));
}

export function emptyState({ iconName = 'info', title, body, action = null }) {
  return el('div', { class: 'state' },
    el('div', { class: 'state__icon', 'aria-hidden': 'true' }, icon(iconName)),
    el('p', { class: 'state__title' }, title),
    body ? el('p', {}, body) : null,
    action);
}

export function errorState(message, retry = null) {
  return el('div', { class: 'state', role: 'alert' },
    el('div', { class: 'state__icon', 'aria-hidden': 'true' }, icon('alert')),
    el('p', { class: 'state__title' }, 'This did not load'),
    el('p', {}, message || 'The request did not complete.'),
    retry ? el('button', { class: 'btn btn--quiet', type: 'button', onclick: retry }, 'Try again') : null);
}

export function notice(kind, title, body, iconName = null) {
  const map = { info: 'info', safe: 'checkCircle', warn: 'alert', caution: 'alert', danger: 'siren' };
  return el('div', { class: `notice notice--${kind === 'warn' ? 'caution' : kind}`, role: kind === 'danger' ? 'alert' : 'note' },
    el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, icon(iconName || map[kind] || 'info')),
    el('div', {}, title ? el('strong', {}, title) : null, body));
}

/**
 * The one loading helper.
 *
 * Shows a skeleton, calls `loader`, then renders the result. Any throw becomes a
 * visible error state with a retry — never a silent blank panel.
 */
export async function loadInto(node, loader, { rows = 3, tall = false } = {}) {
  if (!node) return null;
  mount(node, skeletonList(rows, { tall }));
  try {
    const result = await loader();
    return result;
  } catch (error) {
    mount(node, errorState(error && error.message, () => loadInto(node, loader, { rows, tall })));
    return null;
  }
}

/* ----------------------------------------------------------------- sheets */

let sheetSeq = 0;

/**
 * Open a sheet and remember what had focus, so it can be restored.
 *
 * Native `<dialog>` traps focus while open but does **not** put it back on
 * close, which strands a keyboard or screen-reader user at the top of the
 * document after every dialog. That is the difference between a modal that is
 * usable and one that is not, so it is handled centrally here.
 */
export function openSheet(dialog) {
  const active = document.activeElement;
  dialog.__restoreFocus = active && active !== document.body ? active : null;
  dialog.showModal();
  return dialog.__restoreFocus;
}

function closeSheet(dialog) {
  const restoreTo = dialog.__restoreFocus;
  dialog.close();
  dialog.remove();
  // Restore only if the trigger still exists and is still focusable; a screen
  // that re-rendered underneath the dialog may have replaced it.
  if (restoreTo && document.contains(restoreTo) && typeof restoreTo.focus === 'function') {
    restoreTo.focus({ preventScroll: true });
  }
}

/**
 * A real, accessible modal. Focus is trapped by the native `<dialog>`, Escape
 * closes it, the backdrop click closes it, and focus returns to whatever opened
 * it. Replaces `window.confirm`.
 *
 * @returns {Promise<boolean>} whether the confirming action was chosen
 */
export function confirmSheet({
  title,
  body = null,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  iconName = 'alert',
}) {
  return new Promise((resolve) => {
    const id = `sheSafeSheet${++sheetSeq}`;
    const dialog = el('dialog', { class: 'sheet', id, 'aria-labelledby': `${id}-title` });
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeSheet(dialog);
      resolve(value);
    };

    const panel = el('form', { method: 'dialog', class: 'sheet__panel' },
      el('div', { class: 'sheet__grabber', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet__head' },
        el('div', {},
          el('h2', { id: `${id}-title` }, title),
          body ? el('div', { class: 'card__hint' }, body) : null),
        el('button', { class: 'sheet__close', type: 'button', 'aria-label': 'Close', onclick: () => finish(false) }, icon('x'))),
      el('div', { class: 'stack' },
        el('div', { class: 'notice notice--info' }, el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, icon(iconName)), el('div', {}, el('strong', {}, 'Before you continue'))),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn btn--quiet btn--block', type: 'button', onclick: () => finish(false) }, cancelLabel),
          el('button', { class: `btn btn--block btn--${tone}`, type: 'button', onclick: () => finish(true) }, confirmLabel))));

    dialog.appendChild(panel);
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(false); });
    openSheet(dialog);
    panel.querySelector('.btn--quiet')?.focus();
  });
}

/**
 * A labelled text prompt with validation. Replaces `window.prompt`.
 * @returns {Promise<string|null>}
 */
export function promptSheet({ title, body = null, label = 'Note', value = '', placeholder = '', hint = null, confirmLabel = 'Save', required = true, maxLength = 500 }) {
  return new Promise((resolve) => {
    const id = `sheSafeSheet${++sheetSeq}`;
    const fieldId = `${id}-field`;
    const errorId = `${id}-error`;
    const dialog = el('dialog', { class: 'sheet', id, 'aria-labelledby': `${id}-title` });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      closeSheet(dialog);
      resolve(result);
    };

    const input = el('input', { class: 'input', id: fieldId, value, placeholder, maxlength: String(maxLength), 'aria-describedby': hint ? errorId : null });

    const submit = () => {
      const text = input.value.trim();
      if (required && !text) {
        input.setAttribute('aria-invalid', 'true');
        mount($(`#${errorId}`), 'This is required.');
        input.focus();
        return;
      }
      finish(text);
    };

    const panel = el('form', { class: 'sheet__panel', onsubmit: (event) => { event.preventDefault(); submit(); } },
      el('div', { class: 'sheet__grabber', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet__head' },
        el('div', {},
          el('h2', { id: `${id}-title` }, title),
          body ? el('div', { class: 'card__hint' }, body) : null),
        el('button', { class: 'sheet__close', type: 'button', 'aria-label': 'Close', onclick: () => finish(null) }, icon('x'))),
      el('div', { class: 'stack' },
        el('div', { class: 'field' }, el('label', { for: fieldId }, label), input,
          hint ? el('span', { class: 'field__error', id: errorId }, hint) : null),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn btn--quiet btn--block', type: 'button', onclick: () => finish(null) }, 'Cancel'),
          el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, confirmLabel))));

    dialog.appendChild(panel);
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(null); });
    openSheet(dialog);
    input.focus();
    input.select();
  });
}

/**
 * A multi-option action sheet — one tap to open, then an explicit choice with
 * its consequence spelled out. Replaces the chained `prompt` + `confirm` +
 * `prompt` moderation flow.
 *
 * @returns {Promise<string|null>} the chosen option `id`
 */
export function actionSheet({ title, body = null, options = [], cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const id = `sheSafeSheet${++sheetSeq}`;
    const dialog = el('dialog', { class: 'sheet', id, 'aria-labelledby': `${id}-title` });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeSheet(dialog);
      resolve(value);
    };

    const panel = el('div', { class: 'sheet__panel' },
      el('div', { class: 'sheet__grabber', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet__head' },
        el('div', {},
          el('h2', { id: `${id}-title` }, title),
          body ? el('div', { class: 'card__hint' }, body) : null),
        el('button', { class: 'sheet__close', type: 'button', 'aria-label': 'Close', onclick: () => finish(null) }, icon('x'))),
      el('div', { class: 'choice-list' },
        ...options.map((option) => el(
          'button',
          { class: 'choice', type: 'button', onclick: () => finish(option.id) },
          el('span', { class: 'choice__label' },
            option.iconName ? icon(option.iconName) : null,
            option.label),
          option.hint ? el('span', { class: 'choice__hint' }, option.hint) : null)),
        el('button', { class: 'btn btn--ghost btn--block', type: 'button', onclick: () => finish(null) }, cancelLabel)));

    dialog.appendChild(panel);
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(null); });
    openSheet(dialog);
    panel.querySelector('.btn--quiet')?.focus();
  });
}

/* ---------------------------------------------------------------- helpers */

export function formatClock(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatStamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** `MM:SS` for any remaining-seconds value. One implementation, used everywhere. */
export function formatCountdown(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(safe / 60);
  return `${String(mins).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

export function button(label, { iconName = null, tone = 'quiet', onClick = null, href = null, block = false, size = null, type = 'button', ariaLabel = null, external = false, disabled = false } = {}) {
  const classes = ['btn', `btn--${tone}`];
  if (block) classes.push('btn--block');
  if (size) classes.push(`btn--${size}`);
  const props = { class: classes.join(' ') };
  let tag = 'button';
  if (href) {
    tag = 'a';
    props.href = href;
    if (external) { props.target = '_blank'; props.rel = 'noopener noreferrer'; }
  } else {
    props.type = type;
    if (onClick) props.onclick = onClick;
    if (disabled) props.disabled = true;
  }
  if (ariaLabel) props['aria-label'] = ariaLabel;
  return el(tag, props, iconName ? icon(iconName) : null, label);
}
