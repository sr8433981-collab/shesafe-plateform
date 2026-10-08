/**
 * SheSafe — application bootstrap.
 *
 * Responsibilities: resolve the session, register routes, wire the shell, and
 * keep the store and the DOM in sync. Feature logic lives in ./modules/*.
 */

import { api, ApiError } from './core/api.js';
import { $, $$, el, announce, emptyState, errorState, mount, notice, relativeTime } from './core/dom.js';
import { toast } from './core/feedback.js';
import { locationManager } from './core/location.js';
import { createMap, invalidate, userIcon } from './core/mapkit.js';
import * as router from './core/router.js';
import { store } from './core/store.js';

import * as contacts from './modules/contacts.js';
import * as intelligence from './modules/intelligence.js';
import * as journey from './modules/journey.js';
import * as places from './modules/places.js';
import * as reports from './modules/reports.js';
import * as sharing from './modules/sharing.js';
import * as sos from './modules/sos.js';
import * as voice from './modules/voice.js';

const routes = {
  home: { view: 'view-home', title: 'Dashboard' },
  sharing: { view: 'view-sharing', title: 'Live location' },
  intelligence: { view: 'view-intelligence', title: 'Safety intelligence' },
  route: { view: 'view-route', title: 'Safety navigation' },
  places: { view: 'view-places', title: 'Safe places' },
  journey: { view: 'view-journey', title: 'Journey guard' },
  reports: { view: 'view-reports', title: 'Community safety' },
  assist: { view: 'view-assist', title: 'What should I do?' },
  history: { view: 'view-history', title: 'Incident history' },
  security: { view: 'view-security', title: 'Privacy & security' },
};

const viewLoaders = {
  sharing: loadSharingView,
  intelligence: intelligence.renderAssessment,
  route: () => { places.renderRouteForm(); invalidate(); },
  places: places.renderPlaces,
  journey: () => { journey.loadJourney(); journey.loadHistory(); },
  reports: reports.loadReports,
  assist: () => {},
  history: loadHistoryView,
  security: loadSecurityView,
};

let sharingMap = null;

/* ------------------------------------------------------------------ boot */

async function boot() {
  registerRoutes();
  wireShell();
  wireAuth();
  renderDemoRibbon();

  let session = null;
  try {
    session = await api.session();
  } catch (error) {
    // An unreachable server must not be disguised as a working session, and it
    // must not wipe the shell either: the emergency helpline links stay usable.
    showServerDown(error);
    return;
  }

  store.set({
    authenticated: Boolean(session.authenticated),
    user: session.user,
    sessionChecked: true,
    demoMode: Boolean(session.demoMode),
  });

  if (session.authenticated) {
    await enterApp();
  } else {
    showAuth();
  }

  loadCapabilities().catch(() => {});
  router.start();
}

function showServerDown(error) {
  const banner = $('#server-down');
  if (!banner) return;
  banner.hidden = false;
  mount(
    banner,
    notice(
      'danger',
      'Cannot reach the SheSafe server',
      `${error.message} SheSafe cannot record an incident or alert your contacts until the server is reachable. ` +
        'If this is an emergency, call 112 now.',
    ),
    el('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } },
      el('a', { class: 'call-112', href: 'tel:112', style: { flex: '1' } }, '🚨 Call 112'),
      el('a', { class: 'btn btn--ghost', href: 'tel:181' }, '181 Women helpline'),
      el('button', { class: 'btn btn--quiet', type: 'button', onclick: () => window.location.reload() }, 'Retry'),
    ),
  );
}

function registerRoutes() {
  for (const [name, config] of Object.entries(routes)) {
    router.defineRoute(name, config.view, { title: config.title });
  }
  router.setNotFound('view-home');

  router.onBeforeNavigate(async ({ to }) => {
    const { authenticated, sessionChecked } = store.get();
    if (!sessionChecked) return true;
    if (!authenticated && to !== 'home') {
      router.navigate('home');
      toast('Please sign in to continue.', 'warning');
      return false;
    }
    return true;
  });

  // Lazily load each view when it is shown.
  //
  // This listener runs *before* the router's own render listener, so it must
  // derive the route name from the hash itself. Reading `currentRoute()` here
  // would return the previous view and load the wrong screen.
  window.addEventListener('hashchange', () => {
    const { name } = router.parseHashState();
    if (!name || !viewLoaders[name]) return;
    // Do not fire a private view's loader before the session is resolved: it
    // would populate the screen with a 401 error the user never asked for.
    if (!store.get().sessionChecked) return;
    if (!store.get().authenticated && name !== 'home') return;
    void viewLoaders[name]();
    invalidate();
  });
}

/* ------------------------------------------------------------------ shell */

function wireShell() {
  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-open-modal]');
    if (opener) {
      event.preventDefault();
      document.getElementById(opener.dataset.openModal)?.showModal();
      return;
    }
    const closer = event.target.closest('[data-close-modal]');
    if (closer) {
      event.preventDefault();
      document.getElementById(closer.dataset.closeModal)?.close();
      return;
    }
    const link = event.target.closest('[data-route-link]');
    if (link) {
      event.preventDefault();
      window.location.hash = link.dataset.routeLink;
      return;
    }
    if (event.target.closest('[data-goto-sos]')) {
      event.preventDefault();
      window.location.hash = '#/home';
      window.setTimeout(() => $('#btn-sos')?.focus(), 220);
    }
  });

  // Close dialogs on backdrop click.
  for (const dialog of $$('dialog.modal')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  // Escape closes the topmost dialog (native behaviour, made explicit for Safari).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const open = $$('dialog[open]').pop();
      if (open) open.close();
    }
  });

  $('#btn-sos')?.addEventListener('click', () => {
    if (store.get().sosPhase === 'COUNTDOWN') void sos.cancelBeforeActivation();
    else void sos.arm('button');
  });
  $('#btn-siren-toggle')?.addEventListener('click', onSirenToggle);
  $('#btn-voice-sos')?.addEventListener('click', onVoiceClick);
  $('#btn-account')?.addEventListener('click', openAccount);

  mount($('#add-contact-body'), contacts.contactForm());
  mount($('#report-form-body'), reports.reportForm());

  $('#btn-assist')?.addEventListener('click', () => {
    const value = $('#assist-input').value.trim();
    if (!value) {
      toast('Describe what is happening first.', 'warning');
      return;
    }
    void reports.runIncidentAssist(value);
  });

  $('#btn-refresh-places')?.addEventListener('click', () => void places.renderPlaces());
  $('#btn-location-toggle')?.addEventListener('click', () => void toggleLocation());
  $('#btn-start-share')?.addEventListener('click', () => void onStartShare());
  $('#btn-stop-share')?.addEventListener('click', () => void sharing.revokeSharing());
}

function wireAuth() {
  const loginTab = $('#tab-login');
  const signupTab = $('#tab-signup');

  loginTab.addEventListener('click', () => switchAuthTab('login'));
  signupTab.addEventListener('click', () => switchAuthTab('signup'));

  $('#toggle-password')?.addEventListener('click', (event) => {
    const input = $('#login-password');
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    event.currentTarget.setAttribute('aria-pressed', String(!shown));
    event.currentTarget.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
  });

  $('#form-login')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const response = await api.login($('#login-identifier').value.trim(), $('#login-password').value);
      store.set({ authenticated: true, user: response.user });
      toast(`Welcome back, ${firstName(response.user.name)}.`, 'success');
      await enterApp();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#form-signup')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
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
      toast('Account created. Add a second contact so someone else can reach you too.', 'success', { timeout: 8000 });
      await enterApp();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

function switchAuthTab(which) {
  const isLogin = which === 'login';
  $('#tab-login').setAttribute('aria-selected', String(isLogin));
  $('#tab-signup').setAttribute('aria-selected', String(!isLogin));
  $('#form-login').hidden = !isLogin;
  $('#form-signup').hidden = isLogin;
  $(isLogin ? '#login-identifier' : '#signup-name').focus();
}

function showAuth() {
  $('#view-auth').hidden = false;
  for (const view of $$('[data-view]')) if (view.id !== 'view-auth') view.hidden = true;
  if (!location.hash || location.hash === '#/home') window.location.hash = '#/home';
}

async function enterApp() {
  $('#view-auth').hidden = true;
  await router.render();

  const user = store.get().user;
  $('#home-first-name').textContent = user ? firstName(user.name) : 'there';
  $('#home-subtitle').textContent = `${greeting()}. Your emergency controls, all in one place.`;
  $('#header-status').replaceChildren(el('span', { class: 'badge badge--muted', id: 'header-location-badge' }, 'Location off'));

  await Promise.allSettled([
    contacts.loadContacts({ silent: true }),
    journey.loadJourney({ silent: true }),
    sharing.refreshShares(),
    renderHelplines(),
    sos.initSos({ onChange: renderEmergencyState }),
  ]);

  locationManager.readBattery();
  renderEmergencyState();
  renderLocationSummary();
  renderLocationToggle();
  renderJourneyMini();
  await loadCapabilities();

  const { name } = router.currentRoute() || {};
  if (name && viewLoaders[name]) await viewLoaders[name]();

  if (!locationManager.isStreaming) {
    toast('Tip: switch location on once so SOS can capture your position automatically.', 'info', { timeout: 7000 });
  }
}

/* ------------------------------------------------------------- emergency */

function renderEmergencyState() {
  const host = $('#emergency-banner');
  if (!host) return;
  const { incident, sosPhase, cancelSecondsLeft, sirenOn } = store.get();

  // Keep the SOS button label in sync with the lifecycle.
  const sosButton = $('#btn-sos');
  if (sosButton) {
    const active = ['ACTIVE', 'ESCALATING'].includes(sosPhase);
    sosButton.querySelector('.sos-button__label').textContent = active ? 'STOP' : 'SOS';
    sosButton.querySelector('.sos-button__sub').textContent = active ? 'Stand down' : 'Tap once';
    sosButton.setAttribute('aria-label', active ? 'Stand down the emergency' : 'Start an emergency SOS');
  }
  const sirenBtn = $('#btn-siren-toggle');
  if (sirenBtn) {
    sirenBtn.textContent = sirenOn ? '🔊 Siren on' : '🔇 Siren off';
    sirenBtn.setAttribute('aria-pressed', String(Boolean(sirenOn)));
  }

  if (sosPhase === 'COUNTDOWN' && incident) {
    mount(
      host,
      el(
        'div',
        { class: 'card', style: { borderColor: 'var(--brand-400)', background: 'var(--brand-50)' } },
        el('div', { class: 'row row--between' },
          el('h3', { class: 'card__title' }, 'Emergency armed'),
          el('span', { class: 'badge badge--danger' }, `Cancelling in ${cancelSecondsLeft}s`),
        ),
        el('p', { class: 'card__hint' }, `Reference ${incident.reference}. Nothing has been sent yet.`),
        el('button', { class: 'btn btn--ghost btn--block', type: 'button', onclick: () => void sos.cancelBeforeActivation() }, 'Cancel the emergency'),
      ),
    );
    return;
  }

  if (!['ACTIVE', 'ESCALATING'].includes(sosPhase) || !incident) {
    host.replaceChildren();
    return;
  }

  const summary = incident.notificationSummary || {};
  mount(
    host,
    el(
      'div',
      { class: 'sos-active' },
      el('div', { class: 'row row--between' },
        el('h2', {}, incident.state === 'ESCALATING' ? 'Escalating' : 'Emergency active'),
        el('span', { class: 'badge badge--danger' }, `Ref ${incident.reference}`),
      ),

      incident.location
        ? el('p', { class: 'tiny', style: { marginTop: '8px' } },
            `📍 ${incident.location.lat.toFixed(5)}, ${incident.location.lng.toFixed(5)} (±${Math.round(incident.location.accuracyM || 0)}m) · ${relativeTime(incident.location.recordedAt)}`)
        : el('p', { class: 'tiny', style: { marginTop: '8px' } }, '📍 No position captured yet.'),

      el('div', { class: 'metric-grid', style: { marginTop: '14px' } },
        el('div', { class: 'metric' },
          el('div', { class: 'metric__label' }, 'Delivered'),
          el('div', { class: 'metric__value' }, String(summary.delivered ?? 0))),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__label' }, 'Simulated'),
          el('div', { class: 'metric__value' }, String(summary.simulated ?? 0))),
        el('div', { class: 'metric' },
          el('div', { class: 'metric__label' }, 'Unavailable'),
          el('div', { class: 'metric__value' }, String((summary.unavailable ?? 0) + (summary.failed ?? 0)))),
      ),

      summary.statement ? el('p', { class: 'tiny', style: { marginTop: '10px' } }, summary.statement) : null,

      el('a', { class: 'call-112', href: 'tel:112', style: { marginTop: '16px' } }, '🚨 Call 112 now'),

      el('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } },
        el('button', { class: 'btn btn--ghost', type: 'button', style: { flex: '1' }, onclick: () => void sos.escalate() }, 'Escalate'),
        el('button', { class: 'btn btn--quiet', type: 'button', style: { flex: '1' }, onclick: () => void sos.resolve('User confirmed they are safe.') }, 'I am safe — stand down'),
      ),

      el('details', { style: { marginTop: '12px' } },
        el('summary', { class: 'tiny', style: { cursor: 'pointer', fontWeight: '700' } }, 'Incident timeline'),
        el('ol', { class: 'timeline', style: { marginTop: '10px' } },
          ...(incident.timeline || []).map((entry) =>
            el('li', { class: 'timeline__item' },
              el('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
              el('div', {},
                el('div', { class: 'timeline__state' }, entry.state),
                el('div', { class: 'timeline__meta' }, `${entry.detail || ''} · ${relativeTime(entry.at)}`),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function onSirenToggle() {
  const on = sos.toggleSound();
  const btn = $('#btn-siren-toggle');
  if (btn) {
    btn.textContent = on ? '🔊 Siren on' : '🔇 Siren off';
    btn.setAttribute('aria-pressed', String(on));
  }
}

/* ---------------------------------------------------------------- voice */

async function onVoiceClick() {
  const modal = $('#voice-modal');
  const body = $('#voice-body');
  if (!voice.isSupported()) {
    mount(
      body,
      notice('warn', 'Voice SOS unavailable in this browser',
        'Speech recognition needs Chrome, Edge or Safari, a secure (https) connection and microphone permission. The SOS button works everywhere.'),
      el('button', { class: 'btn btn--ghost btn--block', type: 'button', onclick: () => voice.stop() }, 'Close'),
    );
    modal.showModal();
    return;
  }

  mount(
    body,
    el('p', { class: 'tiny' }, 'Say "SheSafe, emergency". That starts the same ten-second cancel countdown as the button — it never alerts anyone on its own.'),
    el('div', { class: 'row', style: { gap: '10px' } },
      el('span', { class: 'voice-wave', 'aria-hidden': 'true' }, el('span'), el('span'), el('span'), el('span')),
      el('span', { id: 'voice-status' }, 'Not listening'),
    ),
    el('div', { class: 'row', style: { gap: '8px' } },
      el('button', { class: 'btn btn--brand', type: 'button', id: 'voice-toggle', onclick: () => void toggleVoice() }, 'Start listening'),
      el('button', { class: 'btn btn--quiet', type: 'button', onclick: () => { voice.stop(); modal.close(); } }, 'Close'),
    ),
    el('p', { class: 'tiny' }, 'Last heard: ', el('span', { id: 'voice-transcript', class: 'mono' }, '—')),
  );
  modal.showModal();
}

async function toggleVoice() {
  const status = $('#voice-status');
  const button = $('#voice-toggle');
  if (store.get().voiceListening) {
    voice.stop();
    status.textContent = 'Not listening';
    button.textContent = 'Start listening';
    return;
  }
  const started = await voice.start();
  if (started) {
    status.textContent = 'Listening — say "SheSafe, emergency"';
    button.textContent = 'Stop listening';
  }
  store.on('voiceListening', (listening) => {
    const transcript = $('#voice-transcript');
    if (transcript && voice.getTranscript()) transcript.textContent = voice.getTranscript();
    if (status) status.textContent = listening ? 'Listening…' : 'Not listening';
  });
}

/* ------------------------------------------------------------- location */

async function toggleLocation() {
  if (locationManager.isStreaming) {
    locationManager.stop();
    renderLocationToggle();
    renderLocationSummary();
    toast('Location streaming stopped.', 'info');
    return;
  }
  try {
    await locationManager.start();
    renderLocationToggle();
    renderLocationSummary();
    toast('Location on. Your position is used only for SOS, sharing and safety scores.', 'success');
  } catch (error) {
    toast(error.message, 'warning', { timeout: 9000 });
    renderLocationToggle();
  }
}

function renderLocationToggle() {
  const button = $('#btn-location-toggle');
  if (!button) return;
  const streaming = locationManager.isStreaming;
  button.textContent = streaming ? 'Location on — stop' : 'Enable location';
  button.className = streaming ? 'btn btn--ghost' : 'btn btn--brand';

  const badge = $('#header-location-badge');
  if (badge) {
    badge.textContent = streaming ? 'Location on' : 'Location off';
    badge.className = `badge ${streaming ? 'badge--safe' : 'badge--muted'}`;
  }
}

function renderLocationSummary() {
  const host = $('#location-summary');
  if (!host) return;
  const location = store.get().location;
  const { locationPermission, locationError } = store.get();

  if (locationPermission === 'unsupported') {
    mount(host, notice('warn', 'Not supported', locationError || 'This browser has no location API.'));
    return;
  }
  if (!location) {
    mount(host, emptyState({
      glyph: '📍',
      title: locationPermission === 'prompt' ? 'Location is off' : 'Waiting for a position',
      body: locationError || 'Switch location on to enable SOS position capture, live sharing and safety scores.',
    }));
    return;
  }
  mount(
    host,
    el('div', { class: 'metric-grid' },
      metric('Accuracy', `±${Math.round(location.accuracyM || 0)}`, 'm'),
      metric('Battery', location.batteryPct != null ? String(location.batteryPct) : '—', location.batteryPct != null ? '%' : ''),
      metric('Updated', relativeTime(location.recordedAt), ''),
    ),
    el('p', { class: 'mono tiny', style: { marginTop: '10px' } }, `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`),
    locationError ? el('p', { class: 'tiny', style: { color: 'var(--warn-700)' } }, locationError) : null,
  );
}

function metric(label, value, unit) {
  return el('div', { class: 'metric' },
    el('div', { class: 'metric__label' }, label),
    el('div', { class: 'metric__value' }, value, unit ? el('small', {}, ` ${unit}`) : null));
}

async function onStartShare() {
  const result = await sharing.startSharing({ ttlSeconds: 3600 });
  if (!result) return;
  await renderSharingView();
  renderSharingControls();
}

function renderSharingControls() {
  const active = store.get().sharingActive;
  const start = $('#btn-start-share');
  const stop = $('#btn-stop-share');
  if (start) start.disabled = active;
  if (stop) stop.disabled = !active;

  const badge = $('#sharing-status-badge');
  if (badge) {
    badge.textContent = active ? 'Sharing' : 'Not sharing';
    badge.className = `badge ${active ? 'badge--safe' : 'badge--muted'}`;
  }
  const dashBadge = $('#sharing-badge');
  if (dashBadge) {
    dashBadge.textContent = active ? 'Sharing' : 'Off';
    dashBadge.className = `badge ${active ? 'badge--safe' : 'badge--muted'}`;
  }
}

/* -------------------------------------------------------- sharing view */

async function loadSharingView() {
  await Promise.allSettled([renderLocationSummary(), sharing.refreshLatest(), renderSharesList(), renderShareActions()]);
  renderSharingControls();
  renderSharingMap();
}

function renderSharesList() {
  const target = $('#shares-list');
  if (!target) return;
  void sharing.refreshShares().then((shares) => {
    if (!shares.length) {
      mount(target, emptyState({ glyph: '🔗', title: 'No active links', body: 'Start sharing to create an expiring tracking link.' }));
      return;
    }
    mount(target, el('ul', { class: 'list' }, ...shares.map((share) =>
      el('li', { class: 'list__item' },
        el('div', { class: 'list__icon', 'aria-hidden': 'true' }, '🔗'),
        el('div', { class: 'list__body' },
          el('div', { class: 'list__title' }, share.label),
          el('div', { class: 'list__meta' },
            `${share.status} · expires ${new Date(share.expiresAt).toLocaleString()} · ${share.viewCount} views`),
          share.linkedIncidentId ? el('span', { class: 'badge badge--danger', style: { marginTop: '4px' } }, 'Linked to an incident') : null,
        ),
        share.status === 'active'
          ? el('button', { class: 'btn btn--quiet', type: 'button', onclick: async () => { await sharing.revokeSharing(share.id); renderSharesList(); renderSharingControls(); } }, 'Revoke')
          : el('span', { class: 'badge badge--muted' }, share.status),
      ),
    )));
  });
}

function renderShareActions() {
  const target = $('#share-actions');
  if (!target) return;
  const shares = [];
  void shares;
  mount(
    target,
    el('button', { class: 'btn btn--quiet', type: 'button', id: 'btn-copy-share' }, '📋 Copy link'),
    el('a', { class: 'btn btn--quiet', id: 'btn-sms-share' }, '📱 Open SMS'),
    el('a', { class: 'btn btn--quiet', id: 'btn-wa-share' }, '💬 Open WhatsApp'),
  );

  $('#btn-copy-share')?.addEventListener('click', async () => {
    const url = await currentShareUrl();
    if (url) await sharing.copyShareUrl(url);
  });
  $('#btn-sms-share')?.addEventListener('click', async () => {
    const url = await currentShareUrl();
    if (url) window.location.href = `sms:?&body=${sharing.smsShareText(url, store.get().location?.address)}`;
  });
  $('#btn-wa-share')?.addEventListener('click', async () => {
    const url = await currentShareUrl();
    if (url) window.open(`https://wa.me/?text=${sharing.whatsappShareText(url)}`, '_blank', 'noopener');
  });
}

async function currentShareUrl() {
  const shares = await sharing.refreshShares();
  const active = shares.find((share) => share.status === 'active');
  if (!active) {
    toast('Start live sharing first.', 'warning');
    return null;
  }
  // The raw token is never returned by the API, so rebuild the link from the
  // most recent activation payload held in sessionStorage for this tab only.
  const cached = window.sessionStorage.getItem('shesafe:lastShareUrl');
  if (cached) return cached;
  toast('Open the sharing screen again to get a fresh link.', 'info');
  return null;
}

async function renderSharingView() {
  await loadSharingView();
}

function renderSharingMap() {
  const node = $('#sharing-map');
  const location = store.get().location;
  if (!node || !location || typeof window.L === 'undefined') return;
  if (!sharingMap) {
    sharingMap = createMap(node, { center: [location.lat, location.lng], zoom: 16 });
    invalidate(sharingMap);
  }
  if (!sharingMap.__pin) {
    sharingMap.__pin = window.L.marker([location.lat, location.lng], { icon: userIcon(store.get().sosPhase === 'ACTIVE'), zIndexOffset: 1000 }).addTo(sharingMap);
    sharingMap.__circle = window.L.circle([location.lat, location.lng], {
      radius: location.accuracyM || 30, color: '#e11d48', fillColor: '#fecdd3', fillOpacity: 0.2, weight: 1,
    }).addTo(sharingMap);
  } else {
    sharingMap.__pin.setLatLng([location.lat, location.lng]);
    sharingMap.__circle.setLatLng([location.lat, location.lng]).setRadius(location.accuracyM || 30);
  }
  const caption = $('#sharing-map-caption');
  if (caption) {
    caption.textContent = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} · ±${Math.round(location.accuracyM || 0)}m · ${relativeTime(location.recordedAt)}`;
  }
}

/* ------------------------------------------------------------- journeys */

function renderJourneyMini() {
  const host = $('#journey-mini');
  if (!host) return;
  const journey = store.get().journey;
  const badge = $('#journey-badge');
  if (badge) {
    const labels = {
      ON_JOURNEY: 'On journey', CHECK_IN_REQUIRED: 'Check in', WARNING: 'No response',
      EMERGENCY: 'Escalated', ARRIVED: 'Arrived', CANCELLED: 'Cancelled',
    };
    badge.textContent = journey ? labels[journey.state] || journey.state : 'Idle';
    badge.className = `badge ${journey && ['WARNING', 'EMERGENCY'].includes(journey.state) ? 'badge--danger' : journey && journey.state === 'ON_JOURNEY' ? 'badge--info' : 'badge--muted'}`;
  }
  mount(
    host,
    journey
      ? el('p', { class: 'tiny' }, `${journey.origin} → ${journey.destination} · due ${new Date(journey.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
      : el('p', { class: 'tiny' }, 'No journey in progress.'),
  );
}

store.on('journey', renderJourneyMini);
store.on('location', () => {
  renderLocationSummary();
  renderSharingMap();
});

/* ------------------------------------------------------- history/security */

async function loadHistoryView() {
  const target = $('#history-list');
  if (!target) return;
  mount(target, el('p', { class: 'tiny' }, 'Loading…'));
  try {
    const response = await api.incidents(25);
    const incidents = response.incidents || [];
    if (!incidents.length) {
      mount(target, emptyState({ glyph: '🗂️', title: 'No incidents recorded', body: 'SOS records appear here with their full timeline and what was actually sent.' }));
      return;
    }
    mount(target, el('div', { class: 'stack' }, ...incidents.map(historyCard)));
  } catch (error) {
    mount(target, errorState(error.message, () => loadHistoryView()));
  }
}

function historyCard(incident) {
  const summary = incident.notificationSummary || {};
  return el(
    'article',
    { class: 'card' },
    el('div', { class: 'row row--between' },
      el('h3', { class: 'card__title' }, incident.reference),
      el('span', { class: 'badge badge--muted' }, incident.outcome || incident.state)),
    el('p', { class: 'card__hint' }, `${new Date(incident.createdAt || incident.startedAt || Date.now()).toLocaleString()}${incident.durationMinutes ? ` · ${incident.durationMinutes} min` : ''} · triggered by ${incident.triggerSource || 'button'}`),
    el('div', { class: 'metric-grid', style: { marginTop: '12px' } },
      metric('Delivered', String(summary.delivered ?? 0), ''),
      metric('Simulated', String(summary.simulated ?? 0), ''),
      metric('Unavailable', String(summary.unavailable ?? 0), '')),
    summary.statement ? el('p', { class: 'tiny', style: { marginTop: '10px' } }, summary.statement) : null,
  );
}

async function loadSecurityView() {
  const target = $('#audit-list');
  if (!target) return;
  try {
    const response = await api.get('/meta/audit');
    const entries = response.entries || [];
    if (!entries.length) {
      mount(target, el('p', { class: 'tiny' }, 'No events recorded yet.'));
      return;
    }
    mount(target, el('ul', { class: 'list' }, ...entries.slice(0, 20).map((entry) =>
      el('li', { class: 'list__item' },
        el('div', { class: 'list__icon', 'aria-hidden': 'true' }, entry.outcome === 'success' ? '✓' : '•'),
        el('div', { class: 'list__body' },
          el('div', { class: 'list__title mono' }, entry.action),
          el('div', { class: 'list__meta' }, `${entry.outcome} · ${new Date(entry.created_at).toLocaleString()} · ${entry.request_id || '—'}`)),
      ),
    )));
  } catch (error) {
    mount(target, el('p', { class: 'tiny' }, error.message));
  }
}

/* -------------------------------------------------------------- helpers */

async function renderHelplines() {
  const target = $('#helpline-list');
  if (!target) return;
  try {
    const response = await api.helplines();
    mount(
      target,
      el('ul', { class: 'list' }, ...response.helplines.map((line) =>
        el('li', { class: 'list__item' },
          el('div', { class: 'list__icon', 'aria-hidden': 'true' }, '📞'),
          el('div', { class: 'list__body' },
            el('div', { class: 'list__title' }, line.title),
            el('div', { class: 'list__meta' }, `${line.category} · ${line.note}`)),
          el('a', { class: 'btn btn--quiet', href: `tel:${line.number}`, 'aria-label': `Call ${line.title} on ${line.number}` }, line.number),
        ),
      )),
    );
  } catch {
    mount(target, el('p', { class: 'tiny' }, 'Helplines unavailable.'));
  }
}

async function loadCapabilities() {
  try {
    const response = await api.capabilities();
    store.set({ capabilities: response.capabilities, demoMode: store.get().demoMode || response.capabilities?.length >= 0 });
  } catch { /* informational */ }

  const capabilities = store.get().capabilities || [];
  const list = $('#capability-list');
  if (list) {
    mount(list, el('ul', { class: 'list' }, ...capabilities.map(capabilityRow)));
  }
  const strip = $('#capability-strip');
  if (strip && capabilities.length) {
    mount(strip, ...capabilities.filter((c) => ['sos', 'live_location', 'risk_scoring', 'notifications'].includes(c.id)).map((c) =>
      el('span', { class: `badge ${modeClass(c.mode)}` }, `${c.label}: ${c.mode}`)));
  }
}

function capabilityRow(capability) {
  return el(
    'li',
    { class: 'list__item' },
    el('div', { class: 'list__icon', 'aria-hidden': 'true' }, modeGlyph(capability.mode)),
    el('div', { class: 'list__body' },
      el('div', { class: 'row', style: { gap: '6px' } },
        el('span', { class: 'list__title' }, capability.label),
        el('span', { class: `badge ${modeClass(capability.mode)}` }, capability.mode)),
      el('div', { class: 'list__meta' }, capability.detail)),
  );
}

const MODE_CLASS = { real: 'badge--safe', simulated: 'badge--simulated', unavailable: 'badge--muted', partial: 'badge--warn' };
const MODE_GLYPH = { real: '✓', simulated: '⚗', unavailable: '✕', partial: '◐' };
const modeClass = (mode) => MODE_CLASS[mode] || 'badge--muted';
const modeGlyph = (mode) => MODE_GLYPH[mode] || '•';

function renderDemoRibbon() {
  const host = $('#demo-ribbon-host');
  if (!host) return;
  store.on('demoMode', (isDemo) => {
    host.replaceChildren();
    if (isDemo) {
      host.appendChild(el('div', { class: 'demo-ribbon', role: 'note' }, 'Demo mode · simulated data is labelled throughout'));
    }
  });
  if (store.get().demoMode) {
    host.appendChild(el('div', { class: 'demo-ribbon', role: 'note' }, 'Demo mode · simulated data is labelled throughout'));
  }
}

function openAccount() {
  const body = $('#account-body');
  const user = store.get().user;
  if (!user) return;

  const sirenToggle = el('input', { type: 'checkbox', id: 'pref-siren', checked: user.sirenEnabled });
  const trailToggle = el('input', { type: 'checkbox', id: 'pref-trail', checked: user.shareTrailByDefault });
  const locationToggle = el('input', { type: 'checkbox', id: 'pref-location', checked: user.locationConsent });

  mount(
    body,
    el('div', { class: 'stack' },
      el('dl', { class: 'kv' },
        el('dt', {}, 'Name'), el('dd', {}, user.name),
        el('dt', {}, 'Email'), el('dd', {}, user.email || '—'),
        el('dt', {}, 'Mobile'), el('dd', {}, user.phone || '—'),
        el('dt', {}, 'Blood group'), el('dd', {}, user.bloodGroup || '—'),
        el('dt', {}, 'Medical notes'), el('dd', {}, user.emergencyNotes || '—'),
      ),
      el('hr', { style: { border: 'none', borderTop: '1px solid var(--border)' } }),
      el('label', { class: 'checkbox', for: 'pref-siren' }, sirenToggle, 'Audible siren during SOS'),
      el('label', { class: 'checkbox', for: 'pref-trail' }, trailToggle, 'Include movement trail in share links'),
      el('label', { class: 'checkbox', for: 'pref-location' }, locationToggle, 'Store recent position for my own recall'),
      el('button', {
        class: 'btn btn--brand btn--block',
        type: 'button',
        onclick: async () => {
          try {
            const response = await api.updateProfile({
              sirenEnabled: sirenToggle.checked,
              shareTrailByDefault: trailToggle.checked,
              locationConsent: locationToggle.checked,
            });
            store.set({ user: response.user });
            toast('Preferences saved.', 'success');
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      }, 'Save preferences'),
      el('a', { class: 'btn btn--ghost btn--block', href: '#/security', onclick: () => $('#account-modal').close() }, 'Privacy & security'),
      el('button', {
        class: 'btn btn--quiet btn--block',
        type: 'button',
        onclick: async () => {
          try { await api.logout(); } catch { /* already gone */ }
          locationManager.stop();
          location.reload();
        },
      }, 'Sign out'),
    ),
  );
  $('#account-modal').showModal();
}

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

window.addEventListener('beforeunload', () => {
  locationManager.stop();
});

void boot();

export { announce, ApiError };