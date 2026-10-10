/**
 * SheSafe — application bootstrap and shell.
 *
 * Responsibilities, and nothing else:
 *   1. resolve the session and decide which surface is visible,
 *   2. register routes behind an authentication gate,
 *   3. build the navigation from one definition, so no view is unreachable,
 *   4. keep the shell (header, emergency bar, connectivity) in sync with state,
 *   5. hand the DOM over to ./modules/*.
 *
 * The rule that matters most here: the authentication screen is **not** a route.
 * A signed-out visitor cannot reach a private view by typing a hash, and the
 * smoke test asserts exactly that.
 */

import { api } from './core/api.js';
import { $, $$, el, mount } from './core/dom.js';
import { toast } from './core/feedback.js';
import { locationManager } from './core/location.js';
import { invalidate } from './core/mapkit.js';
import * as router from './core/router.js';
import { store } from './core/store.js';
import {
  card, dataList, dataRow, icon, loadInto, notice, openSheet, pill, safetyTimeline, skeletonList,
} from './core/ui.js';

import * as contacts from './modules/contacts.js';
import * as dashboard from './modules/dashboard.js';
import * as intelligence from './modules/intelligence.js';
import * as journey from './modules/journey.js';
import * as places from './modules/places.js';
import * as reports from './modules/reports.js';
import * as security from './modules/security.js';
import * as sharing from './modules/sharing.js';
import * as sos from './modules/sos.js';
import * as voice from './modules/voice.js';

/* ------------------------------------------------------------- structure */

/** One definition drives the tab bar, the desktop rail and the router. */
const ROUTES = {
  home: { view: 'view-home', title: 'Dashboard', label: 'Dashboard', icon: 'home', group: 'Protect' },
  journey: { view: 'view-journey', title: 'Journey Guard', label: 'Journey Guard', icon: 'navigate', group: 'Protect' },
  sharing: { view: 'view-sharing', title: 'Live location', label: 'Live location', icon: 'pin', group: 'Protect' },
  intelligence: { view: 'view-intelligence', title: 'Safety intelligence', label: 'Safety intelligence', icon: 'gauge', group: 'Understand' },
  route: { view: 'view-route', title: 'Safer routes', label: 'Safer routes', icon: 'route', group: 'Understand' },
  places: { view: 'view-places', title: 'Safe places', label: 'Safe places', icon: 'hospital', group: 'Understand' },
  reports: { view: 'view-reports', title: 'Community safety', label: 'Community safety', icon: 'community', group: 'Understand' },
  assist: { view: 'view-assist', title: 'What should I do?', label: 'What should I do?', icon: 'info', group: 'Record' },
  history: { view: 'view-history', title: 'Incident history', label: 'Incident history', icon: 'archive', group: 'Record' },
  security: { view: 'view-security', title: 'Privacy & capability', label: 'Privacy & capability', icon: 'lock', group: 'Record' },
};

/** The five that fit a phone. Everything else lives in the rail and in-content. */
const TABS = ['home', 'journey', 'sharing', 'intelligence', 'places'];

const VIEW_LOADERS = {
  sharing: () => sharing.renderSharingView(),
  intelligence: () => intelligence.renderAssessment(),
  route: () => { places.renderRouteForm(); invalidate(); },
  places: () => places.renderPlaces(),
  journey: () => Promise.allSettled([journey.loadJourney(), journey.loadHistory()]),
  reports: () => reports.loadReports(),
  assist: () => {
    // Re-running the classifier on every visit would be noise; clear any stale
    // result from a previous session instead so the screen never shows advice
    // about a situation that is no longer current.
    const host = document.getElementById('assist-result');
    if (host && !host.querySelector('.card')) mount(host);
  },
  history: () => loadHistoryView(),
  security: () => security.renderSecurityView(),
};

const AUTH_POINTS = [
  ['siren', 'Deterministic SOS', 'A real incident record with a reference you can read out, and every state change timestamped.'],
  ['pin', 'Live location with expiring links', '256-bit tokens, revocable in one tap, no user id in the URL.'],
  ['gauge', 'Explainable safety score', 'Weighted rules, visible contributions, honest confidence.'],
  ['lock', 'Privacy-first by default', 'Location is off until you switch it on, throttled, and expiring.'],
];

/* ------------------------------------------------------------------ boot */

async function boot() {
  mount($('#boot-state'), skeletonList(2));
  buildBrand();
  buildNavigation();
  decorateViewIcons();
  registerRoutes();
  wireShell();
  wireAuth();
  wireConnectivity();

  let session = null;
  try {
    session = await api.session();
  } catch (error) {
    // An unreachable server must not be disguised as a working session, and it
    // must not wipe the shell: the helplines stay usable.
    mount($('#boot-state'));
    showServerDown(error);
    return;
  }

  store.set({
    authenticated: Boolean(session.authenticated),
    user: session.user,
    sessionChecked: true,
    demoMode: Boolean(session.demoMode),
  });

  await loadCapabilities();

  if (session.authenticated) {
    mount($('#boot-state'));
    await enterApp();
  } else {
    mount($('#boot-state'));
    showAuth();
  }

  router.start({ gate: authGate });
}

function authGate(name) {
  const { authenticated } = store.get();
  if (!authenticated) {
    showAuth();
    return false;
  }
  return true;
}

function showServerDown(error) {
  const banner = $('#server-down');
  if (!banner) return;
  banner.hidden = false;
  mount(banner,
    card(null, {
      body: [
        notice('danger', 'Cannot reach the SheSafe server', `${error.message} SheSafe cannot record an incident or alert your contacts until the server is reachable.`),
        el('div', { class: 'btn-row' },
          el('a', { class: 'call-112', href: 'tel:112' }, icon('phone'), 'Call 112'),
          el('a', { class: 'btn btn--quiet', href: 'tel:181' }, icon('phone'), '181 women helpline'),
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => window.location.reload() }, icon('refresh'), 'Retry')),
        el('p', { class: 'small' }, 'Official helplines are listed below and work without SheSafe.'),
      ],
    }));
}

function showAuth() {
  const authView = $('#view-auth');
  if (authView) authView.hidden = false;
  // Hide every authenticated surface, including the navigation, so a signed-out
  // visitor cannot see — or interact with — anything that needs an account.
  // Only the route views. `document.body` also carries a data attribute for
  // the active route, and hiding it would blank the whole page.
  for (const view of $$('section[data-view]')) view.hidden = true;
  for (const link of $$('#tabbar a, #nav-rail a')) link.hidden = true;
  // The rail is `display: block` from 1024px up, so hiding only its links still
  // leaves the section labels painted over the sign-in screen. Hide the nav
  // elements themselves.
  for (const nav of [$('#tabbar'), $('#nav-rail')]) if (nav) nav.hidden = true;
  $('#shell').classList.remove('shell--railed');
  document.title = 'Sign in · SheSafe';
  document.body.dataset.activeView = 'auth';
  dashboard.renderEmergencyBar();
  mount($('#header-status'));
  if (!location.hash || location.hash === '#/home') history.replaceState(null, '', '#/home');
}

function showApp() {
  $('#view-auth').hidden = true;
  $('#shell').classList.add('shell--railed');
  for (const nav of [$('#tabbar'), $('#nav-rail')]) if (nav) nav.hidden = false;
  for (const link of $$('#tabbar a, #nav-rail a')) link.hidden = false;
}

async function enterApp() {
  showApp();
  await router.render({ gate: authGate });

  const user = store.get().user;
  $('#home-first-name').textContent = user ? firstName(user.name) : 'there';
  $('#home-eyebrow').textContent = `${greeting()} · ${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}`;

  sos.initSos({ onChange: renderEmergencyState });

  locationManager.readBattery();
  renderEmergencyState();

  // One pass over everything the dashboard shows. Previously these were two
  // passes (here, then again inside refreshDashboardData) which doubled the boot
  // request count for contacts, journeys, capabilities and the assessment.
  await Promise.allSettled([loadHelplines(), loadCapabilities()]);
  await dashboard.refreshDashboardData();
  renderDemoGuide();

  const { name } = router.currentRoute() || {};
  if (name && VIEW_LOADERS[name]) await VIEW_LOADERS[name]();

  if (!locationManager.isStreaming) {
    toast('Location is off. Switch it on once so SOS can attach a position automatically.', 'info', { timeout: 8000 });
  }
}

/* ----------------------------------------------------------- navigation */

function buildBrand() {
  mount($('#brand-mark'), icon('shield'));
  mount($('#btn-account'), icon('settings'));
  mount($('#toggle-password'), icon('eye'));
  for (const dialog of $$('dialog.sheet')) {
    mount(dialog.querySelector('.sheet__close'), icon('x'));
  }
}

/** Icons injected into the static markup so no emoji ships in the HTML. */
function decorateViewIcons() {
  for (const node of $$('[id$="-back-icon"]')) mount(node, icon('arrowLeft'));
  mount($('#auth-emergency'),
    el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, icon('siren')),
    el('div', {},
      el('strong', {}, 'In an emergency right now?'),
      el('a', { href: 'tel:112' }, 'Call 112'),
      ' · ',
      el('a', { href: 'tel:181' }, '181'),
      ' (women helpline) · ',
      el('a', { href: 'tel:100' }, '100'),
      ' (police)'));
  mount($('#auth-points'),
    ...AUTH_POINTS.map(([iconName, title, detail]) =>
      el('li', {}, icon(iconName), el('span', {}, el('strong', {}, title), ' — ', detail))));
}

function buildNavigation() {
  const tabbar = $('#tabbar');
  const rail = $('#nav-rail');
  if (tabbar) {
    mount(tabbar, ...TABS.map((name) => {
      const config = ROUTES[name];
      return el('a', { class: 'tabbar__link', href: `#/${name}`, 'data-route': name },
        icon(config.icon), el('span', {}, config.label));
    }));
  }
  if (rail) {
    const groups = new Map();
    for (const [name, config] of Object.entries(ROUTES)) {
      if (!groups.has(config.group)) groups.set(config.group, []);
      groups.get(config.group).push([name, config]);
    }
    mount(rail, ...Array.from(groups, ([group, items]) =>
      el('div', { class: 'nav-rail__group' },
        el('p', { class: 'nav-rail__label' }, group),
        ...items.map(([name, config]) =>
          el('a', { class: 'nav-rail__link', href: `#/${name}`, 'data-route': name },
            icon(config.icon), el('span', {}, config.label))))));
  }
}

function registerRoutes() {
  for (const [name, config] of Object.entries(ROUTES)) {
    router.defineRoute(name, config.view, { title: config.title });
  }
  router.setNotFound('view-home');
  router.onBeforeNavigate(async ({ to }) => {
    const { authenticated, sessionChecked } = store.get();
    if (!sessionChecked) return true;
    if (!authenticated && to !== 'home') {
      showAuth();
      return false;
    }
    return true;
  });

  // Lazily load each view when it is shown.
  //
  // This listener runs *before* the router's own render listener, so it derives
  // the route name from the hash itself. Reading `currentRoute()` here would
  // return the previous view and load the wrong screen.
  window.addEventListener('hashchange', () => {
    const { name } = router.parseHashState();
    if (!name || !VIEW_LOADERS[name]) return;
    const { authenticated, sessionChecked } = store.get();
    if (!sessionChecked || !authenticated) return;
    void VIEW_LOADERS[name]();
    invalidate();
  });
}

/* --------------------------------------------------------------- shell */

function wireShell() {
  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-open-modal]');
    if (opener) {
      event.preventDefault();
      const dialog = document.getElementById(opener.dataset.openModal);
      if (dialog) {
        // Remember the trigger so focus can be returned when the dialog closes.
        dialog.__restoreFocus = opener;
        dialog.showModal();
      }
      return;
    }
    const closer = event.target.closest('[data-close-modal]');
    if (closer) {
      event.preventDefault();
      document.getElementById(closer.dataset.closeModal)?.close();
    }
  });

  /**
 * Static dialogs in the markup (contacts, report, account, voice).
 *
 * Native `<dialog>` traps focus but does not restore it, so closing one of these
 * with Escape or a backdrop click would otherwise strand a keyboard or
 * screen-reader user at the top of the document.
 */
for (const dialog of $$('dialog.sheet')) {
  const opener = () => {
    const active = document.activeElement;
    return active && active !== document.body && !dialog.contains(active) ? active : null;
  };
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const restoreTo = opener();
    dialog.close();
    if (restoreTo && document.contains(restoreTo)) restoreTo.focus({ preventScroll: true });
  });
  dialog.addEventListener('cancel', () => { /* native close; focus restored below */ });
  dialog.addEventListener('close', () => {
    const restoreTo = dialog.__restoreFocus;
    if (restoreTo && document.contains(restoreTo) && typeof restoreTo.focus === 'function') {
      restoreTo.focus({ preventScroll: true });
    }
    dialog.__restoreFocus = null;
  });
}

  $('#btn-account')?.addEventListener('click', openAccount);

  // The advisory classifier is a real screen with a real button; wire it here so
  // it cannot silently become a dead control again.
  $('#btn-assist')?.addEventListener('click', () => {
    const input = $('#assist-input');
    const value = (input?.value || '').trim();
    if (!value) {
      toast('Describe what is happening first.', 'warning');
      input?.focus();
      return;
    }
    void reports.runIncidentAssist(value);
  });
  window.addEventListener('shesafe:voice', onVoiceClick);
  window.addEventListener('shesafe:demo-jump', (event) => demoJump(event.detail));

  mount($('#sheet-contact-body'), contacts.contactForm());
  mount($('#contacts-body'),
    el('div', { class: 'stack' },
      el('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: () => contacts.openContactForm() }, icon('plus'), 'Add a trusted contact'),
      el('div', { 'data-contacts-list': '1' }),
      notice('caution', 'SheSafe cannot verify a number on its own',
        'A contact marked "self-confirmed" was confirmed by you, not by SheSafe. Requesting a one-time code proves ownership, but without a messaging provider that request is recorded as SIMULATED and nothing is delivered.')));
  mount($('#report-form-body'), reports.reportForm());
}

function wireConnectivity() {
  const set = (online) => {
    const was = store.get().online;
    store.set({ online, reconnecting: !online });
    if (was !== online) {
      toast(online ? 'Back online.' : 'You are offline. SOS cannot be recorded or sent until the connection returns.', online ? 'success' : 'warning', { timeout: 8000 });
    }
    renderConnectivity();
  };
  window.addEventListener('online', () => set(true));
  window.addEventListener('offline', () => set(false));
  if (typeof navigator !== 'undefined' && 'onLine' in navigator) store.set({ online: navigator.onLine !== false });
  renderConnectivity();
}

export function renderConnectivity() {
  const host = $('#connectivity-host');
  if (!host) return;
  const { online, authenticated } = store.get();
  if (online || !authenticated) { mount(host); return; }
  mount(host, el('div', { class: 'offline-bar', role: 'status' },
    icon('wifiOff'),
    el('span', {}, 'Offline. The dashboard, helplines and Call 112 still work. Recording an incident, sharing a link and alerting a contact do not.')));
}

function renderEmergencyState() {
  dashboard.renderEmergency();
  dashboard.renderEmergencyBar();
  dashboard.renderHeaderStatus();
  const emergency = ['ACTIVATING', 'ACTIVE', 'ESCALATING'].includes(store.get().sosPhase);
  for (const link of $$('.tabbar__link')) link.dataset.emergency = String(emergency && link.dataset.route === 'home');
}

/* ----------------------------------------------------------------- auth */

function wireAuth() {
  $('#tab-login').addEventListener('click', () => switchAuthTab('login'));
  $('#tab-signup').addEventListener('click', () => switchAuthTab('signup'));
  for (const form of [$('#form-login'), $('#form-signup')]) {
    form.addEventListener('input', () => clearAuthFeedback(form));
  }

  $('#toggle-password').addEventListener('click', (event) => {
    const input = $('#login-password');
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    event.currentTarget.setAttribute('aria-pressed', String(!shown));
    event.currentTarget.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
  });

  $('#form-login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    clearAuthFeedback(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const response = await api.login($('#login-identifier').value.trim(), $('#login-password').value);
      store.set({ authenticated: true, user: response.user });
      toast(`Welcome back, ${firstName(response.user.name)}.`, 'success');
      await enterApp();
    } catch (error) {
      showAuthFeedback(form, 'Sign-in failed', error.message);
    } finally {
      button.disabled = false;
    }
  });

  $('#form-signup').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    clearAuthFeedback(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const response = await api.signup({
        name: $('#signup-name').value.trim(),
        email: $('#signup-email').value.trim(),
        phone: $('#signup-mobile').value.trim(),
        password: $('#signup-password').value,
        emergencyContactName: $('#signup-contact-name').value.trim(),
        emergencyContactPhone: $('#signup-contact-phone').value.trim(),
        locationConsent: false,
      });
      store.set({ authenticated: true, user: response.user });
      toast('Account created. Add a second contact so someone else can reach you too.', 'success', { timeout: 9000 });
      await enterApp();
    } catch (error) {
      const conflict = error.code === 'email_taken' || error.code === 'phone_taken';
      const status = showAuthFeedback(
        form,
        conflict ? 'Account already exists' : 'Could not create account',
        error.message,
      );
      if (conflict) {
        const identifier = error.code === 'email_taken' ? $('#signup-email').value.trim() : $('#signup-mobile').value.trim();
        status.appendChild(el('button', {
          class: 'btn btn--quiet btn--block',
          type: 'button',
          onclick: () => {
            switchAuthTab('login');
            $('#login-identifier').value = identifier;
            $('#login-password').focus();
          },
        }, 'Go to sign in'));
      }
    } finally {
      button.disabled = false;
    }
  });
}

function clearAuthFeedback(form) {
  const target = document.getElementById(`${form.id.slice(5)}-feedback`);
  if (!target) return;
  mount(target);
  target.hidden = true;
}

function showAuthFeedback(form, title, message) {
  const target = document.getElementById(`${form.id.slice(5)}-feedback`);
  if (!target) return null;
  mount(target, notice('danger', title, message));
  target.hidden = false;
  target.scrollIntoView({ block: 'nearest' });
  return target;
}

function switchAuthTab(which) {
  const isLogin = which === 'login';
  $('#tab-login').setAttribute('aria-selected', String(isLogin));
  $('#tab-signup').setAttribute('aria-selected', String(!isLogin));
  $('#form-login').hidden = !isLogin;
  $('#form-signup').hidden = isLogin;
  $(isLogin ? '#login-identifier' : '#signup-name').focus();
}

function renderDemoLogin() {
  const host = $('#demo-login-box');
  if (!host || !store.get().demoMode) { mount(host); return; }
  mount(host,
    notice('info', 'Demo mode is on', 'The banner stays visible for the whole session. Simulated surfaces are badged SIMULATED.'),
    el('button', {
      class: 'btn btn--quiet btn--block', type: 'button', dataset: { demoLogin: '1' },
      onclick: () => {
        $('#login-identifier').value = 'demo@shesafe.local';
        $('#login-password').value = 'shesafe-demo';
        $('#form-login').requestSubmit();
      },
    }, icon('play'), 'Sign in as the demo account'));
}

/* ------------------------------------------------------------- helplines */

/**
 * Fetch the published helpline directory once and keep it in the store.
 *
 * The dashboard re-renders on every state change, so anything rendered directly
 * into a dashboard node is destroyed on the next paint. Holding the numbers in
 * the store means the SOS dock can render them again, every time.
 */
async function loadHelplines() {
  try {
    const response = await api.helplines();
    store.set({ helplines: response.helplines || [] });
  } catch (error) {
    store.set({ helplines: [] });
    toast(`${error.message} In an emergency, call 112.`, 'warning', { timeout: 9000 });
  }
}

/* ------------------------------------------------------------ capabilities */

async function loadCapabilities() {
  try {
    const response = await api.capabilities();
    store.set({ capabilities: response.capabilities || [] });
    security.renderCapabilityStrip($('#capability-strip'), response.capabilities || []);
    security.renderCapabilityDisclaimers($('#capability-disclaimers'), response.disclaimers || []);
    if (response.disclaimers?.length) {
      $('#footer-disclaimer').textContent = response.disclaimers.join(' ');
    }
  } catch { /* informational; the privacy screen shows the failure state */ }
  renderDemoLogin();
  renderDemoRibbon();
}

/* ------------------------------------------------------------- demo mode */

function renderDemoRibbon() {
  const host = $('#demo-ribbon-host');
  if (!host) return;
  store.on('demoMode', renderDemoRibbon);
  mount(host, store.get().demoMode
    ? el('div', { class: 'demo-ribbon', role: 'note' }, icon('info'), 'Demo mode · simulated surfaces are labelled SIMULATED')
    : null);
}

/**
 * The 4-minute judge walkthrough, read from the server so the script and the
 * product cannot disagree.
 */
async function renderDemoGuide() {
  if (!store.get().demoMode) return;
  const host = $('#home-secondary');
  if (!host || host.querySelector('.demo-guide')) return;
  try {
    const response = await api.demoScript();
    const guide = el('section', { class: 'card', id: 'demo-guide' },
      el('div', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title' }, `Judge walkthrough · ${response.minutes ?? Math.round(response.totalSeconds / 60)} minutes`),
          el('p', { class: 'card__hint' }, 'Deterministic order, from the server. Follow it top to bottom.'))),
      response.story
        ? el('p', { class: 'demo-story' }, response.story)
        : null,
      el('ol', { class: 'demo-guide' },
        ...response.script.map((step_) => el('li', {},
          el('button', {
            class: 'demo-step', type: 'button',
            onclick: () => window.dispatchEvent(new CustomEvent('shesafe:demo-jump', { detail: step_ })),
          },
            el('span', { class: 'demo-step__n', 'aria-hidden': 'true' }, String(step_.step)),
            el('span', { class: 'grow' },
              el('span', { class: 'demo-step__title' }, step_.title),
              el('span', { class: 'demo-step__say' }, step_.say)),
            el('span', { class: 'small' }, `${step_.seconds}s`))))));
    host.appendChild(guide);
  } catch { /* demo mode is off, or the endpoint is unavailable */ }
}

/**
 * Move the judge to the screen — or the exact block — a demo step is about.
 *
 * Each step may name an `anchor`, so "jump to the ledger" scrolls to the ledger
 * rather than dumping the judge at the top of a long page. Steps whose subject
 * is a control focus that control, so a rehearsal never depends on the operator
 * hunting for a button.
 */
const DEMO_FOCUS = {
  sos: '#btn-sos',
  dashboard: '#btn-sos',
  score: '#assessment-hero',
  why: '#assessment-why',
  change: '#assessment-change',
  guardian: '#btn-start-share',
  cancel: '#btn-sos-stand-down',
  login: '#login-identifier',
};

function demoJump(step_) {
  if (!step_) return;
  window.location.hash = `#/${step_.route || 'home'}`;
  const target = step_.anchor || DEMO_FOCUS[step_.id];
  if (!target) return;
  const attempts = [260, 700, 1400, 2200];
  let index = 0;
  const tryFocus = () => {
    const node = document.querySelector(target);
    if (node) {
      // Scroll first, then focus. Focusing a node that is still loading scrolls
      // back to wherever the browser thinks "top" is.
      node.scrollIntoView({ block: 'center' });
      if (typeof node.focus === 'function') node.focus({ preventScroll: true });
      return;
    }
    index += 1;
    if (index < attempts.length) window.setTimeout(tryFocus, attempts[index] - attempts[index - 1]);
  };
  window.setTimeout(tryFocus, attempts[0]);
}

/* ---------------------------------------------------------------- history */

async function loadHistoryView() {
  const target = $('#history-list');
  if (!target) return;
  await loadInto(target, async () => {
    const response = await api.incidents(50);
    const incidents = response.incidents || [];
    if (!incidents.length) {
      mount(target, el('div', { class: 'state' },
        el('div', { class: 'state__icon', 'aria-hidden': 'true' }, icon('archive')),
        el('p', { class: 'state__title' }, 'No incidents recorded'),
        el('p', {}, 'SOS records appear here with their full timeline and what was actually attempted.')));
      return response;
    }
    mount(target, ...incidents.map((incident) => historyCard(incident.id, incident)));
    return response;
  }, { rows: 3 });
}

const OUTCOME_TONE = { RESOLVED_SAFE: 'safe', RESOLVED_ESCALATED: 'danger', CANCELLED: 'neutral' };

function historyCard(id, incident) {
  const summary = incident.notificationSummary || {};
  return card(`Incident ${incident.reference}`, {
    hint: [
      new Date(incident.createdAt || incident.startedAt || Date.now()).toLocaleString(),
      incident.durationMinutes ? `${incident.durationMinutes} min` : null,
      `triggered by ${incident.triggerSource || 'button'}`,
    ].filter(Boolean).join(' · '),
    action: pill((incident.outcome || incident.state).replace(/_/g, ' '), OUTCOME_TONE[incident.outcome] || 'neutral'),
    body: [
      el('div', { class: 'metric-grid' },
        metricCell('Delivered', summary.delivered ?? 0),
        metricCell('Simulated', summary.simulated ?? 0),
        metricCell('Unavailable', (summary.unavailable ?? 0) + (summary.failed ?? 0)),
        metricCell('Skipped', summary.skipped ?? 0)),
      summary.statement ? el('p', { class: 'small' }, summary.statement) : null,
      incident.location
        ? el('p', { class: 'mono small' }, `${incident.location.lat.toFixed(5)}, ${incident.location.lng.toFixed(5)} (±${Math.round(incident.location.accuracyM || 0)}m)`)
        : el('p', { class: 'small' }, 'No position was captured for this incident.'),
      (incident.notifications || []).length
        ? dataList((incident.notifications || []).map((attempt) => dataRow({
            iconName: attempt.status === 'sent' ? 'checkCircle' : attempt.status === 'failed' ? 'alert' : 'info',
            title: `${String(attempt.channel).toUpperCase()} · ${attempt.status.toUpperCase()}`,
            badges: [pill(attempt.status, attempt.status === 'sent' ? 'safe' : attempt.status === 'failed' ? 'danger' : attempt.status === 'simulated' ? 'simulated' : 'neutral')],
            meta: attempt.detail,
          })))
        : el('p', { class: 'small' }, 'No contact notification was attempted.'),
      el('button', {
        class: 'btn btn--quiet btn--block', type: 'button',
        onclick: async (event) => {
          const host = event.currentTarget.parentElement;
          const existing = host.querySelector('.timeline-host');
          if (existing) { existing.remove(); return; }
          try {
            const full = await api.incident(id);
            // The enriched record when the server has it: timestamp, type, status
            // and a sentence, the same shape as every other timeline.
            const events = full.incident.safetyTimeline?.length
              ? full.incident.safetyTimeline
              : full.incident.timeline || [];
            host.appendChild(el('div', { class: 'timeline-host pad-top' },
              el('div', { class: 'section-title' }, 'Full timeline'),
              safetyTimeline(events, { showTypes: false })));
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      }, icon('list'), 'Show the full timeline'),
    ],
  });
}

function metricCell(label, value) {
  return el('div', { class: 'metric' },
    el('div', { class: 'metric__label' }, label),
    el('div', { class: 'metric__value' }, String(value)));
}

/* ---------------------------------------------------------------- account */

function openAccount() {
  const body = $('#account-body');
  const user = store.get().user;
  if (!user) return;

  const sirenToggle = el('input', { type: 'checkbox', id: 'pref-siren', checked: user.sirenEnabled });
  const trailToggle = el('input', { type: 'checkbox', id: 'pref-trail', checked: user.shareTrailByDefault });
  const emergencyNotes = el('input', { class: 'input', id: 'pref-notes', maxlength: '500', value: user.emergencyNotes || '', placeholder: 'Anything a responder should know' });
  const bloodGroup = el('input', { class: 'input', id: 'pref-blood', maxlength: '8', value: user.bloodGroup || '', placeholder: 'e.g. B+' });

  mount(body,
    el('div', { class: 'stack' },
      el('dl', { class: 'kv' },
        el('dt', {}, 'Name'), el('dd', {}, user.name),
        el('dt', {}, 'Email'), el('dd', {}, user.email || '—'),
        el('dt', {}, 'Mobile'), el('dd', {}, user.phone || '—')),
      el('div', { class: 'grid grid--2' },
        el('div', { class: 'field' }, el('label', { for: 'pref-blood' }, 'Blood group'), bloodGroup),
        el('div', { class: 'field' }, el('label', { for: 'pref-notes' }, 'Medical / emergency notes'), emergencyNotes)),
      el('hr', { class: 'rule' }),
      el('label', { class: 'checkbox', for: 'pref-siren' }, sirenToggle, 'Audible siren during SOS'),
      el('label', { class: 'checkbox', for: 'pref-trail' }, trailToggle, 'Include movement trail in share links'),
      el('button', {
        class: 'btn btn--primary btn--block', type: 'button',
        onclick: async () => {
          try {
            const response = await api.updateProfile({
              sirenEnabled: sirenToggle.checked,
              shareTrailByDefault: trailToggle.checked,
              bloodGroup: bloodGroup.value.trim(),
              emergencyNotes: emergencyNotes.value.trim(),
            });
            store.set({ user: response.user });
            toast('Preferences saved.', 'success');
          } catch (error) { toast(error.message, 'error'); }
        },
      }, icon('checkCircle'), 'Save preferences'),
      el('div', { class: 'btn-row' },
        el('a', { class: 'btn btn--ghost btn--block', href: '#/security', onclick: () => $('#sheet-account').close() }, icon('lock'), 'Privacy & capability'),
        el('button', {
          class: 'btn btn--quiet btn--block', type: 'button',
          onclick: async () => {
            try { await api.logout(); } catch { /* already gone */ }
            locationManager.stop();
            location.reload();
          },
        }, icon('logOut'), 'Sign out')),
      el('p', { class: 'small' }, 'Medical details are stored so they can be shown on your incident record. SheSafe does not send them to anyone without a configured provider.')));
  openSheet($('#sheet-account'));
}

/* ------------------------------------------------------------------ voice */

function onVoiceClick() {
  const modal = $('#sheet-voice');
  const body = $('#voice-body');
  const nodes = voice.renderBody({
    toggle: () => void toggleVoice(),
    close: () => modal.close(),
  });
  mount(body, ...nodes);
  openSheet(modal);
}

async function toggleVoice() {
  const status = $('#voice-status');
  const button = $('#voice-toggle');
  if (store.get().voiceListening) {
    voice.stop();
    if (status) status.textContent = 'Not listening';
    if (button) mount(button, icon('mic'), 'Start listening');
    return;
  }
  const started = await voice.start((source) => sos.arm(source));
  if (!started) {
    if (status) status.textContent = 'Could not start listening';
    return;
  }
  if (status) status.textContent = 'Listening — say "SheSafe, emergency"';
  if (button) mount(button, icon('mute'), 'Stop listening');
  store.on('voiceListening', (listening) => {
    const transcript = $('#voice-transcript');
    if (transcript && voice.getTranscript()) transcript.textContent = voice.getTranscript();
    if (status) status.textContent = listening ? 'Listening…' : 'Not listening';
  });
}

/* --------------------------------------------------------------- helpers */

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/* ------------------------------------------------------------ PWA / misc */

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

window.addEventListener('beforeunload', () => locationManager.stop());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.get().authenticated) {
    void dashboard.refreshDashboardData();
  }
});

store.on('location', () => dashboard.renderDashboard());
store.on('journey', () => dashboard.renderDashboard());
store.on('contacts', () => dashboard.renderDashboard());
// Safety movement belongs on the first screen: once a comparison exists, the
// dashboard shows it without the reader having to navigate to find it.
store.on('comparison', () => dashboard.renderDashboard());

boot().catch((error) => {
  // A boot failure must be visible, not silent: the shell stays usable for the
  // helplines, but the app says so.
  console.error('[shesafe] boot failed', error);
  const banner = document.getElementById('server-down');
  if (banner) {
    banner.hidden = false;
    mount(banner, notice('danger', 'SheSafe could not start', String(error && error.message ? error.message : error)));
  }
});
