/**
 * Safe DOM primitives.
 *
 * Every builder here uses `textContent` / `setAttribute`. There is no
 * `innerHTML` anywhere in this codebase's data path, so a contact named
 * `<img onerror=...>` or an incident titled `</script><script>` is inert by
 * construction rather than by escaping discipline.
 *
 * Presentation helpers (icons, badges, metrics, timelines, states, sheets) live
 * in ./ui.js so that the visual vocabulary has exactly one home.
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

/* --------------------------------------------------------- announcements */

function liveRegion(id, politeness) {
  let region = document.getElementById(id);
  if (!region) {
    region = el('div', { id, class: 'sr-only', role: politeness === 'assertive' ? 'alert' : 'status', 'aria-live': politeness });
    document.body.appendChild(region);
  }
  return region;
}

/**
 * Announce a routine status change.
 *
 * Screen readers ignore a region whose text is set twice within the same tick,
 * so the message is cleared first and re-set on the next frame. The region is
 * created once and reused so live-region semantics are not re-registered.
 */
export function announce(message) {
  const region = liveRegion('live-region', 'polite');
  region.textContent = '';
  window.setTimeout(() => { region.textContent = message; }, 60);
}

/**
 * Announce an emergency state change.
 *
 * Emergency transitions must interrupt whatever the screen reader is saying —
 * a polite region would queue the message behind whatever else is in flight,
 * which is the wrong behaviour when someone has just pressed SOS.
 */
export function announceUrgent(message) {
  const region = liveRegion('live-region-urgent', 'assertive');
  region.textContent = '';
  window.setTimeout(() => { region.textContent = message; }, 40);
}

/* ------------------------------------------------------------ formatters */

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
