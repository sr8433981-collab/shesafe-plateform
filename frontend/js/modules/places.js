/**
 * Safe places (OpenStreetMap) and Safe Route (OSRM), plus the map renderers.
 */

import { api } from '../core/api.js';
import {
  clearLayer, createMap, invalidate, isLeafletAvailable, placePopup,
  poiIcon, userIcon, CATEGORY_STYLE, ROUTE_COLORS,
} from '../core/mapkit.js';
import { el, emptyState, errorState, mount, notice, skeletonList } from '../core/dom.js';
import { locationManager } from '../core/location.js';
import { store } from '../core/store.js';

const state = {
  placesMap: null,
  routeMap: null,
  placeMarkers: { layers: [] },
  routeLayers: { layers: [] },
  userMarker: null,
  accuracyCircle: null,
  routePolylines: [],
};

function requireLeaflet(container, message) {
  if (isLeafletAvailable()) return true;
  mount(container, notice('warn', 'Map library unavailable', message || 'The map could not be loaded because Leaflet did not load. Everything else on this screen still works.'));
  return false;
}

/* ------------------------------------------------------------ safe places */

export async function renderPlaces() {
  const listTarget = document.getElementById('places-list');
  const mapNode = document.getElementById('places-map');
  if (listTarget) mount(listTarget, skeletonList(3));

  let params = null;
  const location = store.get().location;
  if (location) params = { lat: location.lat, lng: location.lng, radiusKm: 8 };

  try {
    const response = await api.places(params);
    renderPlaceList(listTarget, response);
    renderPlacesMap(mapNode, response);
    return response;
  } catch (error) {
    if (listTarget) mount(listTarget, errorState(error.message, () => renderPlaces()));
    if (mapNode) mount(mapNode, notice('warn', 'No map', 'Enable location and reload to see the map.'));
    return null;
  }
}

function renderPlaceList(target, response) {
  if (!target) return;
  const places = response.places || [];

  if (!places.length) {
    mount(
      target,
      el(
        'div',
        { class: 'stack' },
        notice(
          'warn',
          response.provenance?.mode === 'simulated' ? 'Demo data in use' : 'No nearby facilities loaded',
          response.fallbackNote || response.provenance?.note || 'SheSafe does not show places it cannot verify.',
        ),
        ...(response.fallbackHelplines || []).map((line) =>
          el(
            'a',
            { class: 'btn btn--ghost btn--block', href: `tel:${line.number}` },
            `${line.title} · ${line.number}`,
          ),
        ),
        response.mapSearchUrl
          ? el('a', { class: 'btn btn--quiet btn--block', href: response.mapSearchUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Search a live map instead')
          : null,
      ),
    );
    return;
  }

  const header = el(
    'div',
    { class: 'row row--between', style: { marginBottom: '10px' } },
    el('span', { class: 'badge badge--info' }, `${places.length} places`),
    response.provenance?.mode === 'simulated'
      ? el('span', { class: 'badge badge--simulated' }, 'Simulated')
      : el('span', { class: 'badge badge--muted' }, 'OpenStreetMap'),
  );

  mount(
    target,
    header,
    el('ul', { class: 'list' }, ...places.map(placeRow)),
    el('p', { class: 'tiny', style: { marginTop: '10px' } }, response.provenance?.note || ''),
  );
}

function placeRow(place) {
  const style = CATEGORY_STYLE[place.category] || { label: place.categoryLabel || 'Place', glyph: '•' };
  const openBadge =
    place.openState === 'open'
      ? el('span', { class: 'badge badge--safe' }, place.is247 ? '24/7' : 'Open (tagged)')
      : place.openState === 'closed'
        ? el('span', { class: 'badge badge--warn' }, 'Tagged closed')
        : el('span', { class: 'badge badge--muted' }, 'Hours unknown');

  return el(
    'li',
    { class: 'list__item' },
    el('div', { class: 'list__icon', 'aria-hidden': 'true' }, style.glyph),
    el(
      'div',
      { class: 'list__body' },
      el('div', { class: 'list__title' }, place.name),
      el(
        'div',
        { class: 'list__meta' },
        `${style.label} · ${place.distanceText} · ${place.etaMinutesWalk} min walk`,
        place.address ? ` · ${place.address}` : '',
      ),
      el('div', { class: 'row', style: { gap: '4px', marginTop: '4px' } }, openBadge,
        place.womenFriendly ? el('span', { class: 'badge badge--violet' }, 'Women friendly') : null,
        place.provenance === 'simulated_demo_dataset' ? el('span', { class: 'badge badge--simulated' }, 'Simulated') : null,
      ),
    ),
    el(
      'div',
      { class: 'list__actions' },
      el('a', { class: 'btn btn--quiet', href: `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`, target: '_blank', rel: 'noopener noreferrer' }, 'Go'),
      place.phone
        ? el('a', { class: 'btn btn--quiet', href: `tel:${String(place.phone).replace(/[^+\d]/g, '')}`, 'aria-label': `Call ${place.name}` }, 'Call')
        : null,
    ),
  );
}

function renderPlacesMap(node, response) {
  if (!node) return;
  if (!requireLeaflet(node, 'Maps come from OpenStreetMap and need the Leaflet library.')) return;

  const origin = response.origin || store.get().location || { lat: 28.6328, lng: 77.2197 };
  if (!state.placesMap) {
    state.placesMap = createMap(node, { center: [origin.lat, origin.lng], zoom: 14 });
    invalidate(state.placesMap);
  } else {
    state.placesMap.setView([origin.lat, origin.lng], state.placesMap.getZoom());
  }

  clearLayer(state.placesMap, state.placeMarkers);
  for (const place of response.places || []) {
    const marker = window.L.marker([place.lat, place.lng], { icon: poiIcon(place.category), title: place.name })
      .addTo(state.placesMap)
      .bindPopup(placePopup(place));
    state.placeMarkers.layers.push(marker);
  }
  drawUserMarker(state.placesMap);
}

function drawUserMarker(map) {
  const location = store.get().location;
  if (!map || !location) return;
  if (!state.userMarker) {
    state.userMarker = window.L.marker([location.lat, location.lng], { icon: userIcon(), zIndexOffset: 1000 }).addTo(map);
    state.accuracyCircle = window.L.circle([location.lat, location.lng], {
      radius: location.accuracyM || 30, color: '#2563eb', fillColor: '#bfdbfe', fillOpacity: 0.15, weight: 1,
    }).addTo(map);
  } else {
    state.userMarker.setLatLng([location.lat, location.lng]);
    state.accuracyCircle.setLatLng([location.lat, location.lng]).setRadius(location.accuracyM || 30);
  }
}

/* ------------------------------------------------------------- safe route */

export function renderRouteForm() {
  const form = document.getElementById('route-form');
  if (!form) return;
  if (form.dataset.bound) return;
  form.dataset.bound = 'true';

  const fromInput = document.getElementById('route-from');
  const toInput = document.getElementById('route-to');
  const modeSelect = document.getElementById('route-mode');
  const useCurrent = document.getElementById('route-use-current');

  useCurrent?.addEventListener('click', () => {
    const location = store.get().location;
    if (!location) {
      window.alert('No position available yet. Enable location first.');
      return;
    }
    fromInput.value = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
    parseInto(fromInput, { lat: location.lat, lng: location.lng });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const from = parseInto(fromInput);
    const to = parseInto(toInput);
    if (!from || !to) {
      window.alert('Enter both points as "latitude, longitude", for example 28.6328, 77.2197.');
      return;
    }
    await planRoutes({ from, to, mode: modeSelect.value });
  });
}

function parseInto(input, fallback) {
  if (fallback) return fallback;
  const raw = (input.value || '').trim();
  const match = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  return { lat: Number(match[1]), lng: Number(match[2]) };
}

export async function planRoutes({ from, to, mode = 'walk' }) {
  const listTarget = document.getElementById('route-results');
  const mapNode = document.getElementById('route-map');
  if (listTarget) mount(listTarget, skeletonList(3));

  try {
    const response = await api.routes({ fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng, mode });
    renderRouteList(listTarget, response);
    renderRouteMap(mapNode, response);
    return response;
  } catch (error) {
    if (listTarget) mount(listTarget, errorState(error.message, null));
    return null;
  }
}

function renderRouteList(target, response) {
  if (!target) return;
  const routes = response.routes || [];

  const provenanceNotice =
    response.provenance?.provider === 'simulated_geometric'
      ? notice('warn', 'SIMULATED ROUTES', response.provenance.note)
      : notice('info', 'Real road routes', `${response.provenance?.note || ''} Safety scoring: ${response.provenance?.safetyEngine || ''}`);

  mount(
    target,
    provenanceNotice,
    el('p', { class: 'tiny', style: { margin: '10px 0' } }, response.disclaimer || ''),
    ...routes.map((route, index) => routeCard(route, index)),
  );
}

function routeCard(route, index) {
  const primaryLabel = (route.labels || [])[0] || 'ALTERNATIVE';
  const color = ROUTE_COLORS[primaryLabel] || ROUTE_COLORS.ALTERNATIVE;

  return el(
    'article',
    {
      class: 'card',
      style: { borderLeft: `4px solid ${color}` },
      dataset: { routeId: route.id },
    },
    el(
      'div',
      { class: 'row row--between', style: { alignItems: 'flex-start' } },
      el(
        'div',
        {},
        el('div', { class: 'row', style: { gap: '6px' } },
          ...(route.labels || []).map((label) =>
            el('span', { class: `badge ${label === 'SAFEST' ? 'badge--safe' : label === 'FASTEST' ? 'badge--info' : label === 'BALANCED' ? 'badge--violet' : 'badge--muted'}` }, label),
          ),
        ),
        el('h3', { style: { marginTop: '4px' } }, route.label || `Option ${index + 1}`),
      ),
      el(
        'div',
        { style: { textAlign: 'right' } },
        el('div', { style: { fontSize: '1.8rem', fontWeight: '800', lineHeight: '1' } }, String(route.safetyScore)),
        el('div', { class: 'tiny' }, `safety / 100 · ${route.band}`),
      ),
    ),

    el(
      'div',
      { class: 'metric-grid', style: { marginTop: '14px' } },
      metric('ETA', `${Math.round(route.durationMin)}`, 'min'),
      metric('Distance', route.distanceKm.toFixed(1), 'km'),
      metric('Confidence', `${Math.round(route.confidence * 100)}`, '%'),
    ),

    el(
      'div',
      { style: { marginTop: '14px' } },
      el('h4', {}, 'Why'),
      el('ul', { style: { listStyle: 'none', padding: '0', marginTop: '6px' } },
        ...(route.whySafer || []).map((reason) => el('li', { class: 'tiny' }, `• ${reason}`)),
      ),
    ),

    el(
      'a',
      {
        class: 'btn btn--brand btn--block',
        href: `https://www.google.com/maps/dir/?api=1&origin=${route.geometry[0][0]},${route.geometry[0][1]}&destination=${route.geometry.at(-1)[0]},${route.geometry.at(-1)[1]}&travelmode=${route.mode === 'drive' ? 'driving' : route.mode === 'cycle' ? 'bicycling' : 'walking'}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: { marginTop: '14px' },
      },
      'Navigate this route',
    ),
  );
}

function metric(label, value, unit) {
  return el(
    'div',
    { class: 'metric' },
    el('div', { class: 'metric__label' }, label),
    el('div', { class: 'metric__value' }, value, unit ? el('small', {}, ` ${unit}`) : null),
  );
}

function renderRouteMap(node, response) {
  if (!node) return;
  if (!requireLeaflet(node)) return;
  const origin = response.origin;
  if (!state.routeMap) {
    state.routeMap = createMap(node, { center: [origin.lat, origin.lng], zoom: 13 });
    invalidate(state.routeMap);
  }
  clearLayer(state.routeMap, state.routeLayers);

  const bounds = [];
  for (const route of response.routes || []) {
    const primaryLabel = (route.labels || [])[0] || 'ALTERNATIVE';
    const color = ROUTE_COLORS[primaryLabel] || ROUTE_COLORS.ALTERNATIVE;
    const polyline = window.L.polyline(route.geometry, {
      color, weight: 5, opacity: 0.85, dashArray: primaryLabel === 'FASTEST' ? null : '10 8', lineJoin: 'round',
    }).addTo(state.routeMap);
    polyline.bindPopup(
      (() => {
        const box = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = `${primaryLabel} · safety ${route.safetyScore}/100 · ${Math.round(route.durationMin)} min`;
        box.appendChild(strong);
        return box;
      })(),
    );
    state.routeLayers.layers.push(polyline);
    bounds.push(polyline.getBounds());
  }
  if (bounds.length) {
    state.routeMap.fitBounds(bounds.reduce((acc, b) => acc.extend(b), bounds[0]), { padding: [24, 24] });
  }
}

export function refreshMaps() {
  invalidate(state.placesMap);
  invalidate(state.routeMap);
}