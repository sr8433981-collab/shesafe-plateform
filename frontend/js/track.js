/**
 * Guardian console.
 *
 * A person following a share link during someone else's emergency needs six
 * things above all, and this screen is ordered by exactly that:
 *
 *   1. CURRENT STATUS  — is there an incident open right now
 *   2. CURRENT LOCATION — where they are, with GPS accuracy
 *   3. LAST UPDATED   — how old that position is, in seconds
 *   4. INCIDENT TIME  — when it was raised, and for how long
 *   5. LOCATION SHARING — whether the position is still being sent
 *   6. TIMELINE       — what SheSafe actually did, step by step
 *
 * The one distinction that must never be ambiguous is **live vs not**. A stale
 * position presented like a live one is the single most dangerous failure mode
 * on this screen, so link state is a server-published word rendered verbatim,
 * with `reconnecting` layered on top when this browser's own polls are failing.
 *
 * Deliberately minimal on credentials: it accepts a share token and nothing
 * else. No login, no user id, no way to enumerate another person's location. A
 * bad token gets one uniform message.
 *
 * Two properties worth stating, because both were wrong in the previous build:
 *
 * 1. **A transient network failure does not end the session.** Polling backs off
 *    and reports `Reconnecting…`; the last known position stays on screen with
 *    its age. Only a hard authorisation failure ends it.
 * 2. **Nothing is ever fabricated.** If no position has been received, the page
 *    says so instead of drawing a plausible dot.
 */

import { ApiError } from './core/api.js';
import { $, el, mount, relativeTime } from './core/dom.js';
import { card, icon, metric, metricGrid, notice, pill, safetyTimeline } from './core/ui.js';
import { token, MAP_TOKENS } from './core/mapkit.js';

const POLL_MS = 4000;
const BACKOFF_STEPS = [4000, 8000, 16000, 30000];
const MAX_BACKOFF = BACKOFF_STEPS[BACKOFF_STEPS.length - 1];

const STATE_META = {
  ARMING: { label: 'Arming', tone: 'caution' },
  COUNTDOWN: { label: 'Armed, not yet sent', tone: 'caution' },
  ACTIVE: { label: 'SOS ACTIVE', tone: 'danger' },
  ESCALATING: { label: 'ESCALATING', tone: 'danger' },
  RESOLVED: { label: 'Stood down', tone: 'safe' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

const JOURNEY_META = {
  ON_JOURNEY: { label: 'On a watched journey', tone: 'info' },
  CHECK_IN_REQUIRED: { label: 'Check-in overdue', tone: 'caution' },
  WARNING: { label: 'No check-in received', tone: 'danger' },
  EMERGENCY: { label: 'Journey escalated to SOS', tone: 'danger' },
  ARRIVED: { label: 'Checked in safely', tone: 'safe' },
  CANCELLED: { label: 'Journey cancelled', tone: 'neutral' },
};

/**
 * The four link states, plus expiry.
 *
 * `word` is what the badge says. `blurb` is the one sentence under it, so the
 * screen never leaves the reader to work out what a bare word means.
 */
const LINK_STATE = {
  live: {
    word: 'LIVE', tone: 'safe', live: true,
    blurb: 'Position is being sent now and this page is up to date.',
  },
  stale: {
    word: 'STALE', tone: 'caution',
    blurb: 'The person stopped sending location. The position below is the last one SheSafe received and is no longer current.',
  },
  reconnecting: {
    word: 'RECONNECTING', tone: 'caution', live: true,
    blurb: 'This page cannot reach SheSafe right now. The position below is the last one it received; do not reload.',
  },
  revoked: {
    word: 'REVOKED', tone: 'neutral',
    blurb: 'The person revoked this link. It stops working immediately.',
  },
  expired: {
    word: 'EXPIRED', tone: 'neutral',
    blurb: 'This link has expired. Ask the person you are tracking for a fresh one.',
  },
};

let shareToken = null;
let map = null;
let marker = null;
let circle = null;
let trailLine = null;
let poller = null;
let attempt = 0;
let consecutiveFailures = 0;
let lastPayload = null;
let lastGoodAt = null;

/* ------------------------------------------------------------------ token */

function readToken() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('t') || params.get('token');
  if (fromQuery) return fromQuery;
  // Also accept a fragment, so a token cannot leak to a server via Referer.
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return fromHash.get('t');
}

/* ------------------------------------------------------------------ poll */

async function poll() {
  try {
    const response = await fetch(`/api/track/${encodeURIComponent(shareToken)}`, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.ok) {
      const error = (payload && payload.error) || {};
      throw new ApiError(error.message || 'This tracking link is not available.', {
        status: response.status, code: error.code || `http_${response.status}`,
      });
    }
    consecutiveFailures = 0;
    attempt = 0;
    lastPayload = payload;
    lastGoodAt = new Date();
    render(payload);
  } catch (error) {
    onPollFailure(error);
  }
}

function onPollFailure(error) {
  const hard = error instanceof ApiError && [401, 403, 404].includes(error.status);
  consecutiveFailures += 1;

  if (hard) {
    stopPolling();
    renderError(error);
    return;
  }

  // Transient: keep the last known position on screen and say what is happening.
  attempt = Math.min(attempt + 1, BACKOFF_STEPS.length - 1);
  restartPolling(BACKOFF_STEPS[attempt]);
  if (lastPayload) {
    // Re-render from the payload we already hold, so the status band switches to
    // RECONNECTING with the same last-known position still on screen.
    render(lastPayload);
    renderStaleNotice(error);
  } else {
    mount($('#loading-panel'),
      el('p', { class: 'state__title' }, 'Reconnecting…'),
      el('p', { class: 'small' }, `${error.message} SheSafe keeps trying. Do not reload.`));
  }
}

/* ---------------------------------------------------------------- render */

function render(data) {
  $('#loading-panel').hidden = true;
  $('#error-panel').hidden = true;
  $('#content-panel').hidden = false;

  const { subject, location, locationStale, locationAgeSeconds, incident, journey, delivery, trail, share } = data;
  const linkState = resolveLinkState(data);

  $('#subject-heading').textContent = subject.displayName;
  $('#subject-address').textContent = location
    ? `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`
    : 'No position has been received yet.';

  renderStatusHeadline(linkState, data);
  renderBadges(incident, journey, linkState);
  renderIncident(incident, delivery);
  renderJourney(journey);
  renderTelemetry({ location, locationStale, locationAgeSeconds, share, delivery, linkState });
  renderActions(subject, location);
  renderTimeline(data);
  renderTrail(trail);
  renderHonesty(data);
  updateMap(location, trail);
}

/**
 * Decide the one word that describes whether this screen can be trusted.
 *
 * The server publishes the truth about the *data* (live / stale / revoked /
 * expired). This browser additionally knows whether *it* can currently reach the
 * server, which is a separate and more urgent fact — so a failed poll outranks
 * everything except revocation.
 */
function resolveLinkState(data) {
  if (consecutiveFailures > 0) return LINK_STATE.reconnecting;
  const key = data.linkState || (data.locationStale ? 'stale' : 'live');
  return LINK_STATE[key] || LINK_STATE.live;
}

/**
 * The status line. This is the answer to "is this person in trouble right now?",
 * so it is a sentence, not a badge — a badge alone can be missed.
 */
function renderStatusHeadline(linkState, data) {
  const host = $('#status-panel');
  if (!host) return;
  const { incident, journey, location, locationAgeSeconds } = data;
  const isOpen = incident && ['ARMING', 'COUNTDOWN', 'ACTIVE', 'ESCALATING'].includes(incident.state);
  const stoodDown = incident && ['RESOLVED', 'CANCELLED'].includes(incident.state);

  let status;
  let tone;
  if (isOpen) {
    status = incident.state === 'ESCALATING'
      ? 'EMERGENCY ESCALATING'
      : incident.state === 'COUNTDOWN'
        ? 'ALERT ARMED, NOT YET SENT'
        : 'SOS ACTIVE';
    tone = 'danger';
  } else if (stoodDown) {
    status = incident.outcome === 'RESOLVED_SAFE' ? 'STOOD DOWN SAFELY' : 'CLOSED';
    tone = 'safe';
  } else if (journey && ['CHECK_IN_REQUIRED', 'WARNING'].includes(journey.state)) {
    status = 'JOURNEY GUARD NEEDS A CHECK-IN';
    tone = 'caution';
  } else if (journey) {
    status = 'ON A WATCHED JOURNEY';
    tone = 'info';
  } else {
    status = 'NO EMERGENCY OPEN';
    tone = 'neutral';
  }

  mount(host,
    el('div', { class: `status-band status-band--${tone}`, dataset: { status: tone } },
      el('span', { class: 'status-band__label' }, status),
      pill(linkState.word, linkState.tone, { live: linkState.live })),
    el('p', { class: 'status-band__blurb' }, linkState.blurb),
    location
      ? el('p', { class: 'small' },
          `Last updated ${formatAge(locationAgeSeconds)}${location.accuracyM != null ? ` · GPS accuracy ±${Math.round(location.accuracyM)} m` : ''}.`)
      : el('p', { class: 'small' }, 'No position has been received. SheSafe will not draw a point it does not have.'));
}

function renderBadges(incident, journey, linkState) {
  const host = $('#subject-badges');
  const bits = [];
  if (incident) {
    const meta = STATE_META[incident.state] || { label: incident.state, tone: 'neutral' };
    bits.push(pill(meta.label, meta.tone, { live: ['ACTIVE', 'ESCALATING'].includes(incident.state) }));
  } else if (journey) {
    const meta = JOURNEY_META[journey.state] || { label: journey.state, tone: 'neutral' };
    bits.push(pill(meta.label, meta.tone));
  }
  bits.push(pill(linkState.word, linkState.tone, { live: linkState.live }));
  if (lastGoodAt) bits.push(pill(`Checked ${relativeTime(lastGoodAt)}`, 'neutral'));
  mount(host, ...bits);
  setConnectionBadge(linkState.word, linkState.tone);
}

/** Age as a short phrase. Seconds matter: "12 minutes ago" hides urgency. */
function formatAge(seconds) {
  if (seconds == null) return 'never';
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  return `${Math.round(seconds / 3600)} hours ago`;
}

function renderIncident(incident, delivery) {
  const host = $('#incident-panel');
  if (!incident) {
    mount(host, notice('info', 'No emergency is open',
      'SheSafe has no active incident for this person right now. If you believe they are in danger, call them directly and call 112.'));
    return;
  }
  const meta = STATE_META[incident.state] || { label: incident.state, tone: 'neutral' };
  mount(host, card(null, {
    body: [
      el('div', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title' }, `Incident ${incident.reference}`),
          el('p', { class: 'card__hint' },
            `${meta.label} · raised ${formatStamp(incident.startedAt)}` +
            (incident.elapsedMinutes != null ? ` · ${incident.elapsedMinutes} min elapsed` : ''))),
        pill(meta.label, meta.tone, { live: ['ACTIVE', 'ESCALATING'].includes(incident.state) })),
      incident.location
        ? metricGrid([
            metric('Anchor position', `${incident.location.lat.toFixed(4)}, ${incident.location.lng.toFixed(4)}`),
            metric('GPS accuracy', `±${Math.round(incident.location.accuracyM || 0)}`, { unit: 'm' }),
            metric('Incident time', formatStamp(incident.startedAt)),
            metric('Still open', formatStamp(incident.resolvedAt) || 'yes'),
          ])
        : el('p', { class: 'small' }, 'No position was captured when this incident was raised.'),
      delivery.attempted
        ? deliveryBlock(delivery)
        : notice('caution', 'No contact alert was attempted',
          'Either no trusted contacts were configured, or the alert could not be attempted. Do not assume anybody was told.'),
      incident.resolvedAt
        ? notice('safe', 'Stood down', `This incident was closed at ${formatStamp(incident.resolvedAt)}.`)
        : notice('danger', 'SheSafe has not contacted emergency services',
          'Nothing in this product calls police, fire or ambulance. If this person is in danger, call 112 now.'),
    ],
  }));
}

function deliveryBlock(delivery) {
  const tone = delivery.delivered ? 'safe' : delivery.failed ? 'danger' : delivery.simulated ? 'simulated' : 'caution';
  const word = delivery.delivered
    ? `${delivery.delivered} confirmed delivered`
    : delivery.failed
      ? `${delivery.failed} failed`
      : delivery.simulated
        ? `${delivery.simulated} recorded as SIMULATED — no external message was sent`
        : 'no provider available';

  return el('div', { class: 'stack stack--tight' },
    el('div', { class: 'section-title' }, 'What SheSafe actually did'),
    pill(word.toUpperCase(), tone),
    metricGrid([
      metric('Attempted', delivery.attempted),
      metric('Delivered', delivery.delivered),
      metric('Simulated', delivery.simulated),
      metric('Unavailable', delivery.unavailable),
    ]),
    el('p', { class: 'small' },
      delivery.channels.length
        ? `Channels: ${delivery.channels.join(', ')}. Last attempt ${relativeTime(delivery.lastAttemptAt)}.`
        : 'No channel recorded an attempt.'));
}

function renderJourney(journey) {
  const host = $('#journey-panel');
  if (!journey) { mount(host); return; }
  const meta = JOURNEY_META[journey.state] || { label: journey.state, tone: 'neutral' };
  mount(host, card('Journey Guard', {
    hint: `${journey.origin} → ${journey.destination} · expected ${journey.expectedMinutes} min · due ${formatStamp(journey.dueAt)}`,
    action: pill(meta.label, meta.tone, { live: ['CHECK_IN_REQUIRED', 'WARNING'].includes(journey.state) }),
    body: [
      ['ON_JOURNEY', 'CHECK_IN_REQUIRED', 'WARNING'].includes(journey.state)
        ? notice('caution', 'Waiting for a check-in',
          'Journey Guard only advances while their app is open. If they do not check in, it warns them — it does not contact you or anyone else on its own.')
        : el('p', { class: 'small' }, 'Journey Guard is not monitoring in the background. It only advances while their app is open.'),
      el('div', { id: 'journey-timeline-host' }),
    ],
  }));
  renderJourneyTimeline(lastPayload || {});
}

function renderTelemetry({ location, locationStale, locationAgeSeconds, share, delivery, linkState }) {
  mount($('#telemetry'), metricGrid([
    metric('Status', linkState.word, { tone: linkState.tone === 'safe' ? 'safe' : linkState.tone === 'danger' ? 'danger' : 'caution' }),
    metric('GPS accuracy', location ? `±${Math.round(location.accuracyM || 0)}` : '—', { unit: location ? 'm' : '' }),
    metric('Last updated', locationAgeSeconds != null ? String(locationAgeSeconds) : '—', { unit: locationAgeSeconds != null ? 'sec ago' : '' }),
    metric('Sharing', locationStale ? 'Stopped' : 'Active'),
    metric('Incident time', incidentTimeLabel()),
    metric('Link expires', formatClock(share.expiresAt)),
    metric('Battery', location?.batteryPct != null ? String(location.batteryPct) : '—', { unit: location.batteryPct != null ? '%' : '' }),
    metric('Times opened', String(share.viewCount ?? 0)),
  ]));
}

/** The moment the incident was raised, read from the last payload. */
function incidentTimeLabel() {
  const incident = lastPayload?.incident;
  if (!incident) return '—';
  return formatClock(incident.startedAt);
}

function renderActions(subject, location) {
  const call = $('#call-subject');
  if (subject.phone && subject.phone.startsWith('***')) {
    call.setAttribute('aria-disabled', 'true');
    call.removeAttribute('href');
    mount(call, icon('phone'), 'Phone number hidden');
  } else if (subject.phone) {
    call.setAttribute('href', `tel:${subject.phone.replace(/\D/g, '')}`);
    mount(call, icon('phone'), `Call ${subject.displayName}`);
  }

  const nav = $('#navigate-subject');
  if (location) {
    nav.setAttribute('href', `https://www.google.com/maps/dir/?api=1&destination=${location.lat},${location.lng}`);
  } else {
    nav.removeAttribute('href');
    nav.setAttribute('aria-disabled', 'true');
  }
}

function renderTimeline(data) {
  const host = $('#timeline-host');
  // The enriched record when the server has it, the compact step list otherwise.
  const events = (data.safetyTimeline && data.safetyTimeline.length) ? data.safetyTimeline : data.timeline || [];
  if (!events.length) {
    mount(host, el('p', { class: 'small' }, 'Nothing has happened yet on this link.'));
    return;
  }
  mount(host,
    safetyTimeline(events.map((entry) => (
      entry.explanation ? entry : { state: entry.state, detail: entry.step, at: entry.at }
    )), { showTypes: false }));
}

/** Journey Guard history, when the person being followed has a journey open. */
function renderJourneyTimeline(data) {
  const host = $('#journey-timeline-host');
  if (!host) return;
  const events = data.journeyTimeline || [];
  mount(host, safetyTimeline(events, { showTypes: false, emptyText: 'No Journey Guard events recorded.' }));
}

function renderTrail(trail) {
  const card_ = $('#trail-card');
  const usable = trail && trail.length > 1;
  card_.hidden = !usable;
  if (!usable) return;
  mount(card_,
    el('div', { class: 'card__head' },
      el('div', {},
        el('h2', { class: 'card__title' }, 'Movement trail'),
        el('p', { class: 'card__hint' }, `${trail.length} recorded positions while this incident is open. The trail exists only for the duration of the incident.`))),
    metricGrid([
      metric('From', new Date(trail[0].at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      metric('To', new Date(trail.at(-1).at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    ]));
}

function renderHonesty(data) {
  mount($('#honesty-note'),
    el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, icon('info')),
    el('div', {},
      el('strong', {}, 'Before you act on this'),
      data.disclaimer,
      el('p', { class: 'small' }, `Link label: ${data.share.label}. Scope: ${data.share.scope}. This link can be revoked by the person at any time.`)));
}

function renderStaleNotice(error) {
  const host = $('#honesty-note');
  const age = lastPayload?.locationAgeSeconds;
  mount(host,
    el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, icon('wifiOff')),
    el('div', {},
      el('strong', {}, 'Reconnecting — this position may be out of date'),
      `${error.message} The position shown was last confirmed ${formatAge(age)}. `
      + 'SheSafe keeps trying. Do not reload.'));
}

function renderError(error) {
  $('#loading-panel').hidden = true;
  $('#content-panel').hidden = true;
  const panel = $('#error-panel');
  panel.hidden = false;
  // A revoked link is not an error the reader can fix, and saying so plainly is
  // kinder than a generic "invalid".
  const revoked = /revoked/i.test(error.message || '');
  mount($('#error-body'),
    el('div', { class: `status-band status-band--${revoked ? 'neutral' : 'danger'}`, dataset: { status: revoked ? 'neutral' : 'danger' } },
      el('span', { class: 'status-band__label' }, revoked ? 'REVOKED' : 'LINK UNAVAILABLE')),
    notice(revoked ? 'info' : 'danger', revoked ? 'This link was revoked' : 'This link cannot be used', error.message),
    el('p', { class: 'small' }, 'Ask the person you are tracking for a fresh SheSafe link. Links expire and can be revoked at any time.'),
    el('p', { class: 'small' }, 'SheSafe will not show a position it does not have, and it does not contact police or ambulance.'));
  mount($('#error-call-112'), icon('phone'), 'Call 112');
  setConnectionBadge(revoked ? 'Revoked' : 'Unavailable', 'neutral');
}

function setConnectionBadge(text, tone) {
  const badge = $('#connection-badge');
  if (!badge) return;
  badge.textContent = text;
  badge.className = `badge badge--${tone}`;
}

/* ------------------------------------------------------------------- map */

function updateMap(location, trail) {
  const node = $('#tracker-map');
  if (!node || !location || typeof window.L === 'undefined') {
    if (node && !location) {
      $('#map-caption').textContent = 'No position has been received from SheSafe.';
    }
    return;
  }

  if (!map) {
    map = window.L.map(node, { zoomControl: true });
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    map.setView([location.lat, location.lng], 16);

    marker = window.L.marker([location.lat, location.lng], {
      icon: window.L.divIcon({
        className: 'user-pin user-pin--incident',
        html: '<span class="user-pin__pulse"></span><span class="user-pin__core"></span>',
        iconSize: [34, 34], iconAnchor: [17, 17],
      }),
      zIndexOffset: 1000,
    }).addTo(map);
    circle = window.L.circle([location.lat, location.lng], {
      radius: location.accuracyM || 30,
      color: token(MAP_TOKENS.accuracy),
      fillColor: token(MAP_TOKENS.accuracyFill),
      fillOpacity: 0.2, weight: 1,
    }).addTo(map);
    trailLine = window.L.polyline([], { color: token(MAP_TOKENS.trail), weight: 3, dashArray: '4 8', opacity: 0.7 }).addTo(map);
  } else {
    marker.setLatLng([location.lat, location.lng]);
    circle.setLatLng([location.lat, location.lng]).setRadius(location.accuracyM || 30);
  }

  if (trail && trail.length) trailLine.setLatLngs(trail.map((point) => [point.lat, point.lng]));

  $('#map-caption').textContent =
    `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} · ±${Math.round(location.accuracyM || 0)}m · ${relativeTime(location.recordedAt)}`;
}

/* ---------------------------------------------------------------- format */

function formatClock(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatStamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------ loop */

function startPolling(interval = POLL_MS) {
  stopPolling();
  poller = window.setInterval(() => void poll(), interval);
}

function stopPolling() {
  if (poller) window.clearInterval(poller);
  poller = null;
}

function restartPolling(interval) {
  startPolling(Math.min(interval, MAX_BACKOFF));
}

function init() {
  mount($('#guardian-mark'), icon('shield'));
  for (const node of [$('#error-call-112'), $('#main-call-112')]) if (node && !node.textContent) mount(node, icon('phone'), 'Call 112');
  const nav = $('#navigate-subject');
  if (nav) mount(nav, icon('pin'), 'Open in maps');

  shareToken = readToken();
  if (!shareToken || shareToken.length < 32) {
    renderError(new ApiError('This link is missing its tracking token.', { status: 403 }));
    return;
  }

  void poll();
  startPolling();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      consecutiveFailures = 0;
      attempt = 0;
      restartPolling(POLL_MS);
      void poll();
    }
  });
  window.addEventListener('online', () => { restartPolling(POLL_MS); void poll(); });
  window.addEventListener('offline', () => setConnectionBadge('Offline', 'caution'));
}

init();
