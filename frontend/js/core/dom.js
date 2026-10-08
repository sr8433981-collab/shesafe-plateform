/**
 * Safe DOM helpers.
 *
 * Every function here builds nodes with `textContent` / `setAttribute`. There is
 * no `innerHTML` anywhere in this codebase's data path, so a contact named
 * `<img onerror=...>` or an incident titled `</script><script>` is inert by
 * construction rather than by escaping discipline.
 */

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') throw new Error('el(): raw html is not allowed');
    else if (key === 'dataset') for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function on(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export function icon(glyph, label) {
  const span = el('span', { 'aria-hidden': 'true' }, glyph);
  if (label) {
    return el('span', { class: 'row', style: { gap: '6px' } }, span, el('span', { class: 'sr-only' }, label));
  }
  return span;
}

export function skeletonList(rows = 3) {
  return el(
    'div',
    { class: 'stack stack--tight', 'aria-hidden': 'true' },
    ...Array.from({ length: rows }, () =>
      el('div', { class: 'skeleton', style: { height: '62px', borderRadius: '14px' } }),
    ),
  );
}

export function emptyState({ glyph = '·', title, body, action }) {
  return el(
    'div',
    { class: 'state' },
    el('div', { class: 'state__icon', 'aria-hidden': 'true' }, glyph),
    el('p', { class: 'state__title' }, title),
    body ? el('p', {}, body) : null,
    action || null,
  );
}

export function errorState(message, retry) {
  return el(
    'div',
    { class: 'state', role: 'alert' },
    el('div', { class: 'state__icon', 'aria-hidden': 'true' }, '!'),
    el('p', { class: 'state__title' }, 'Something went wrong'),
    el('p', {}, message || 'The request did not complete.'),
    retry ? el('button', { class: 'btn btn--ghost', type: 'button', onclick: retry }, 'Try again') : null,
  );
}

export function notice(kind, title, body, glyph) {
  return el(
    'div',
    { class: `notice notice--${kind}`, role: kind === 'danger' ? 'alert' : 'note' },
    el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, glyph || (kind === 'danger' ? '!' : 'i')),
    el('div', {}, title ? el('strong', {}, title) : null, body),
  );
}

/** Announce a message to screen readers without showing a toast. */
export function announce(message) {
  let region = document.getElementById('live-region');
  if (!region) {
    region = el('div', { id: 'live-region', class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(region);
  }
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = message;
  }, 40);
}

export function formatDistance(km) {
  if (km === null || km === undefined) return '—';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

export function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(value) {
  if (!value) return 'never';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return 'never';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : '•••';
}