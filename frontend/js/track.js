/**
 * Guardian tracking page.
 *
 * Deliberately minimal: it accepts a share token and nothing else. There is no
 * user id, no login prompt, and no way to enumerate another person's location.
 * A bad token gets a clear, uniform error - we do not distinguish "unknown",
 * "revoked" and "expired" in the UI beyond the server's own message, because
 * even that distinction leaks a little.
 */

import { ApiError } from './core/api.js';
import { $, el, mount, notice, relativeTime } from './core/dom.js';
import { toast } from './core/feedback.js';

const POLL_MS = 4000;
let token = null;
let map = null;
let marker = null;
let circle = null;
let trailLine = null;
let poller = null;

const STATE_META = {
  ARMING: { label: 'Arming', badge: 'badge--warn' },
  COUNTDOWN: { label: 'Armed', badge: 'badge--warn' },
  ACTIVE: { label: 'Emergency active', badge: 'badge--danger' },
  ESCALATING: { label: 'Escalating', badge: 'badge--danger' },
  RESOLVED: { label: 'Stood down', badge: 'badge--safe' },
  CANCELLED: { label: 'Cancelled', badge: 'badge--muted' },
};

function readToken() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('t') || params.get('token');
  if (fromQuery) return fromQuery;
  // Also accept a fragment, so a token cannot leak to a server via Referer.
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return fromHash.get('t');
}

async function poll() {
  try {
    const response = await fetch(`/api/track/${encodeURIComponent(token)}`, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.ok) {
      throw new ApiError(payload?.error?.message || 'This tracking link is not available.', { status: response.status });
    }
    render(payload);
  } catch (error) {
    stopPolling();
    renderError(error);
  }
}

function render(data) {
  $('#error-panel').hidden = true;
  $('#content-panel').hidden = false;

  const { subject, location, locationStale, locationAgeSeconds, incident, trail, share, disclaimer } = data;

  $('#subject-heading').textContent = subject.displayName;
  $('#subject-address').textContent = location
    ? `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`
    : 'No position received yet.';

  const badge = $('#status-badge');
  if (incident) {
    const meta = STATE_META[incident.state] || { label: incident.state, badge: 'badge--muted' };
    badge.textContent = meta.label;
    badge.className = `badge ${meta.badge}`;
  } else {
    badge.textContent = locationStale ? 'Not sharing' : 'Live';
    badge.className = `badge ${locationStale ? 'badge--warn' : 'badge--safe'}`;
  }

  mount(
    $('#incident-panel'),
    incident
      ? el('div', { class: 'notice notice--danger' },
          el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, '!'),
          el('div', {},
            el('strong', {}, `SheSafe incident ${incident.reference} · ${(STATE_META[incident.state] || {}).label || incident.state}`),
            `Raised ${new Date(incident.startedAt).toLocaleString()}`,
            incident.resolvedAt ? ` · stood down ${new Date(incident.resolvedAt).toLocaleString()}` : '',
          ))
      : null,
    !locationStale && !incident
      ? notice('safe', 'Sharing is active', 'Position updates while their phone has this page open and location enabled.')
      : null,
    locationStale
      ? notice('warn', 'Position may be out of date', `Last update ${relativeTime(location?.recordedAt)}. They may have closed the app or turned sharing off.`)
      : null,
  );

  mount(
    $('#telemetry'),
    metric('Status', locationStale ? 'STALE' : 'LIVE', ''),
    metric('Accuracy', location ? `±${Math.round(location.accuracyM || 0)}` : '—', location ? 'm' : ''),
    metric('Last update', locationAgeSeconds != null ? `${locationAgeSeconds}s` : '—', locationAgeSeconds != null ? 'ago' : ''),
    metric('Link expires', new Date(share.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), ''),
  );

  const callLink = $('#call-subject');
  if (subject.phone && subject.phone.startsWith('***')) {
    callLink.href = 'tel:';
    callLink.textContent = '📞 Phone number hidden';
    callLink.classList.add('btn--quiet');
  }

  const nav = $('#navigate-subject');
  if (location) {
    nav.href = `https://www.google.com/maps/dir/?api=1&destination=${location.lat},${location.lng}`;
  } else {
    nav.removeAttribute('href');
    nav.setAttribute('aria-disabled', 'true');
  }

  const battery = $('#battery-badge');
  if (location && location.batteryPct != null) {
    battery.hidden = false;
    battery.textContent = `🔋 ${location.batteryPct}%`;
    battery.className = `badge ${location.batteryPct < 20 ? 'badge--warn' : 'badge--muted'}`;
  } else {
    battery.hidden = true;
  }

  mount($('#honesty-note'),
    el('span', { class: 'notice__icon', 'aria-hidden': 'true' }, 'i'),
    el('div', {}, el('strong', {}, 'Before you act on this'), disclaimer));

  updateMap(location, trail);
}

function renderError(error) {
  $('#content-panel').hidden = true;
  const panel = $('#error-panel');
  panel.hidden = false;
  mount(
    panel,
    error instanceof ApiError && error.status === 403
      ? notice('danger', 'This link cannot be used', error.message)
      : notice('warn', 'Tracking unavailable', error.message || 'The link could not be loaded.'),
    el('p', { class: 'tiny' }, 'Ask the person you are tracking for a fresh SheSafe link. Links expire and can be revoked at any time.'),
    el('a', { class: 'call-112', href: 'tel:112' }, '🚨 Call 112'),
  );
}

function updateMap(location, trail) {
  if (!location || typeof window.L === 'undefined') return;
  const node = $('#tracker-map');
  if (!map) {
    map = window.L.map(node, { zoomControl: true });
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    map.setView([location.lat, location.lng], 16);

    const icon = window.L.divIcon({
      className: 'user-pin user-pin--incident',
      html: '<span class="user-pin__pulse"></span><span class="user-pin__core"></span>',
      iconSize: [34, 34], iconAnchor: [17, 17],
    });
    marker = window.L.marker([location.lat, location.lng], { icon, zIndexOffset: 1000 }).addTo(map);
    circle = window.L.circle([location.lat, location.lng], {
      radius: location.accuracyM || 30, color: '#e11d48', fillColor: '#fecdd3', fillOpacity: 0.2, weight: 1,
    }).addTo(map);
    trailLine = window.L.polyline([], { color: '#be123c', weight: 3, dashArray: '4 8', opacity: 0.7 }).addTo(map);
  } else {
    marker.setLatLng([location.lat, location.lng]);
    circle.setLatLng([location.lat, location.lng]).setRadius(location.accuracyM || 30);
    map.panTo([location.lat, location.lng], { animate: true });
  }

  if (trail && trail.length) {
    trailLine.setLatLngs(trail.map((point) => [point.lat, point.lng]));
  }

  $('#map-caption').textContent =
    `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} · ±${Math.round(location.accuracyM || 0)}m · ${relativeTime(location.recordedAt)}`;

  const trailPanel = $('#trail-panel');
  trailPanel.hidden = !(trail && trail.length > 1);
  if (trail && trail.length > 1) {
    mount(trailPanel,
      el('h3', { class: 'card__title' }, 'Movement trail'),
      el('p', { class: 'card__hint' }, `${trail.length} recorded positions during this incident. The trail exists only while the incident is open.`),
      el('div', { class: 'row', style: { gap: '8px' } },
        el('span', { class: 'badge badge--muted' }, `From ${new Date(trail[0].at).toLocaleTimeString()}`),
        el('span', { class: 'badge badge--muted' }, `To ${new Date(trail.at(-1).at).toLocaleTimeString()}`)));
  }
}

function metric(label, value, unit) {
  return el('div', { class: 'metric' },
    el('div', { class: 'metric__label' }, label),
    el('div', { class: 'metric__value' }, value, unit ? el('small', {}, ` ${unit}`) : null));
}

function startPolling() {
  stopPolling();
  poller = window.setInterval(() => void poll(), POLL_MS);
}

function stopPolling() {
  if (poller) window.clearInterval(poller);
  poller = null;
}

function init() {
  token = readToken();
  if (!token || token.length < 32) {
    renderError(new ApiError('This link is missing its tracking token.', { status: 403 }));
    return;
  }
  void poll();
  startPolling();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void poll();
  });
}

init();

export { toast };