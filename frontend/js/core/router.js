/**
 * Hash router.
 *
 * `#/dashboard`, `#/safety`, `#/route`, ... Chosen over History API routing so
 * the app works from any static host and from a plain file server without
 * server-side rewrites.
 *
 * Two rules this module owns, both of which the previous version got wrong:
 *
 * 1. **The authentication screen is not a route.** It is a separate surface.
 *    Rendering a route must never be able to reveal an authenticated view to a
 *    signed-out visitor, no matter what the hash says.
 * 2. **Navigation is guarded by session state**, not by an `if` in the click
 *    handler, so deep links, the back button and a cold load all behave the
 *    same way.
 *
 * Accessibility: every navigation sets `aria-current="page"` on all navigation
 * landmarks, moves focus to the view heading, and announces the view name.
 */

import { announce, $$ } from './dom.js';

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

/**
 * Show a view.
 *
 * `gate` is resolved by the caller from the store. When it returns false the
 * router refuses to paint, which is what keeps `#/intelligence` and every other
 * private screen away from a signed-out visitor.
 */
export async function render({ gate = null } = {}) {
  const { name, query } = parseHash();
  const route = routes.get(name);
  const viewId = route ? route.viewId : notFoundView;
  if (!viewId) return null;

  if (beforeEach) {
    const allowed = await beforeEach({ from: current?.name, to: name, viewId });
    if (allowed === false) {
      const back = current ? `#/${current.name}` : '#/home';
      if (window.location.hash !== back) window.location.hash = back;
      return null;
    }
  }

  if (gate && gate(name) === false) return null;

  for (const view of $$('[data-view]')) {
    view.hidden = view.id !== viewId;
  }
  for (const link of $$('[data-route]')) {
    if (link.dataset.route === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  current = { name, query, viewId, title: route ? route.title : 'Not found' };
  document.title = `${route ? route.title : 'Not found'} · SheSafe`;
  // Not `dataset.view`: the view loop above selects `[data-view]`, and giving
  // <body> the same attribute makes the loop hide the entire application the
  // moment a route is not named after the body's (empty) id.
  document.body.dataset.activeView = name;

  // Move focus to the view heading so keyboard and screen-reader users land in
  // the right place after navigating.
  const view = document.getElementById(viewId);
  if (view) {
    const heading = view.querySelector('h1, h2');
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
    // A new view always starts at the top. `scroll-behavior: smooth` on <html>
    // turns this into an animation that races the view's own async content, so
    // the page settles part-way down the dashboard with the SOS control scrolled
    // off the top. `instant` overrides the CSS.
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  announce(current.title);
  return current;
}

export function start(options = {}) {
  window.addEventListener('hashchange', () => render(options));
  render(options);
}
