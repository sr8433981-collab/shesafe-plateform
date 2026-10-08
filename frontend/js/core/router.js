/**
 * Hash router.
 *
 * `#/dashboard`, `#/safety`, `#/route`, ... Chosen over History API routing so the
 * app works from any static host and from a plain file server without
 * server-side rewrites.
 *
 * Accessibility: every navigation sets `aria-current="page"`, moves focus to the
 * view heading, and announces the view name in a live region.
 */

import { $, announce, $$ } from './dom.js';

const routes = new Map();
let notFoundView = null;
let beforeEach = null;
let current = null;

export function defineRoute(name, viewId, { title } = {}) {
  routes.set(name, { name, viewId, title: title || name });
}

export function setNotFound(viewId) {
  notFoundView = viewId;
}

export function onBeforeNavigate(handler) {
  beforeEach = handler;
}

/** The current hash state, without rendering. */
export function parseHashState() {
  return parseHash();
}

function parseHash() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '');
  const [path, queryString = ''] = raw.split('?');
  const name = (path || '').trim() || 'home';
  const query = Object.fromEntries(new URLSearchParams(queryString));
  return { name, query };
}

export function navigate(name, query) {
  const search = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
  const target = `#/${name}${search}`;
  if (window.location.hash === target) render();
  else window.location.hash = target;
}

export function currentRoute() {
  return current;
}

export async function render() {
  const { name, query } = parseHash();
  const route = routes.get(name);
  const viewId = route ? route.viewId : notFoundView;
  if (!viewId) return;

  if (beforeEach) {
    const allowed = await beforeEach({ from: current?.name, to: name, viewId });
    if (allowed === false) {
      // Put the hash back so the URL always reflects the visible view.
      const back = current ? `#/${current.name}` : '#/home';
      if (window.location.hash !== back) window.location.hash = back;
      return;
    }
  }

  for (const view of $$('[data-view]')) {
    const active = view.id === viewId;
    view.hidden = !active;
  }
  for (const link of $$('[data-route]')) {
    const active = link.dataset.route === name;
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  current = { name, query, viewId, title: route ? route.title : 'Not found' };
  document.title = `${route ? route.title : 'Not found'} · SheSafe`;

  // Move focus to the view heading so keyboard and screen-reader users land in
  // the right place after navigating.
  const view = document.getElementById(viewId);
  if (view) {
    const heading = view.querySelector('h1, h2');
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
    view.scrollIntoView({ block: 'start', behavior: 'instant' in window ? 'instant' : 'auto' });
  }
  announce(current.title);
  document.body.dataset.view = name;
}

export function start() {
  window.addEventListener('hashchange', render);
  render();
}

export { $ };