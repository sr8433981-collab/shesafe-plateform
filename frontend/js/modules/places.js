/**
 * Safe places (OpenStreetMap) and safety-aware routing (OSRM), plus the maps.
 *
 * Route presentation is a comparison, not a list: FASTEST / SAFEST / BALANCED
 * side by side with the trade-off spelled out in one line. When the safety
 * coverage is too thin to say anything useful, the screen says
 * "Limited safety data available." rather than inventing a difference.
 */

import { api } from '../core/api.js';
import {
  clearLayer, createMap, invalidate, isLeafletAvailable, placePopup,
  poiIcon, token, userIcon, MAP_TOKENS, CATEGORY_STYLE, ROUTE_TOKENS,
} from '../core/mapkit.js';
import { el, mount } from '../core/dom.js';
import {
  card, dataList, dataRow, disclosure, icon, loadInto, metric, metricGrid,
  notice, pill,
} from '../core/ui.js';
import { store } from '../core/store.js';

const state = {
  placesMap: null,
  routeMap: null,
  placeMarkers: { layers: [] },
  routeLayers: { layers: [] },
  userMarker: null,
  accuracyCircle: null,
};

/** Icon for a safety category. Single vocabulary, shared with the dashboard. */
export function categoryStyle(category) {
  const style = CATEGORY_STYLE[category] || { label: 'Place', iconName: 'info', token: '--poi-default' };
  return { label: style.label, iconName: style.iconName, token: style.token };
}

function requireLeaflet(container, message) {
  if (isLeafletAvailable()) return true;
  mount(container, notice('caution', 'Map library unavailable',
    message || 'The map could not load because Leaflet did not. Everything else on this screen still works.'));
  return false;
}

/* ------------------------------------------------------------ safe places */

export async function loadNearbyPlaces({ limit = null, radiusKm = 8 } = {}) {
  const location = store.get().location;
  const params = location ? { lat: location.lat, lng: location.lng, radiusKm } : null;
  const response = await api.places(params);
  if (!limit) return response;
  return { ...response, places: (response.places || []).slice(0, limit) };
}

export async function renderPlaces() {
  const listTarget = document.getElementById('places-list');
  const actions = document.getElementById('places-actions');

  mount(actions,
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn--primary btn--block', type: 'button', id: 'btn-refresh-places', onclick: () => void renderPlaces() }, icon('refresh'), 'Refresh'),
      el('a', { class: 'btn btn--quiet btn--block', href: 'https://www.google.com/maps/search/hospital+near+me', target: '_blank', rel: 'noopener noreferrer' }, icon('pin'), 'Search Google Maps')));

  await loadInto(listTarget, async () => {
    const response = await loadNearbyPlaces();
    renderPlaceList(listTarget, response);
    renderPlacesMap(document.getElementById('places-map'), response);
    return response;
  }, { rows: 4 });
}

function renderPlaceList(target, response) {
  if (!target) return;
  const places = response.places || [];

  if (!places.length) {
    mount(target, card('Nothing to show', {
      body: [
        notice('caution',
          response.provenance?.mode === 'simulated' ? 'Demo data unavailable' : 'No nearby facilities loaded',
          response.fallbackNote || response.provenance?.note || 'SheSafe does not show places it cannot verify.'),
        ...(response.fallbackHelplines || []).map((line) =>
          el('a', { class: 'btn btn--ghost btn--block', href: `tel:${line.number}` }, icon('phone'), `${line.title} · ${line.number}`)),
        response.mapSearchUrl
          ? el('a', { class: 'btn btn--quiet btn--block', href: response.mapSearchUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Search a live map instead')
          : null,
      ],
    }));
    return;
  }

  mount(target,
    card('OpenStreetMap places near you', {
      hint: response.provenance?.note || 'Crowd-maintained data. Not an official endorsement of any venue.',
      action: pill(response.provenance?.mode === 'simulated' ? 'Simulated' : 'OpenStreetMap',
        response.provenance?.mode === 'simulated' ? 'simulated' : 'info'),
      body: [dataList(places.map(placeRow))],
    }));
}

function placeRow(place) {
  const style = categoryStyle(place.category);
  const openBadge = place.openState === 'open'
    ? pill(place.is247 ? '24/7' : 'Open (tagged)', 'safe')
    : place.openState === 'closed'
      ? pill('Tagged closed', 'caution')
      : pill('Hours unknown', 'neutral');

  return dataRow({
    iconName: style.iconName,
    title: place.name,
    badges: [
      openBadge,
      place.womenFriendly ? pill('Women friendly', 'brand') : null,
      place.provenance === 'simulated_demo_dataset' ? pill('Simulated', 'simulated') : null,
    ],
    meta: [
      style.label,
      place.distanceText,
      place.etaMinutesWalk ? `${place.etaMinutesWalk} min walk` : null,
      place.address,
    ].filter(Boolean).join(' · '),
    actions: [
      el('a', { class: 'btn btn--quiet btn--sm', href: `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Navigate to ${place.name}` }, icon('navigate'), 'Go'),
      place.phone
        ? el('a', { class: 'btn btn--quiet btn--sm', href: `tel:${String(place.phone).replace(/[^+\d]/g, '')}`, 'aria-label': `Call ${place.name}` }, icon('phone'), 'Call')
        : null,
    ],
  });
}

function renderPlacesMap(node, response) {
  if (!node) return;
  if (!requireLeaflet(node, 'Maps come from OpenStreetMap and need the Leaflet library.')) return;

  const origin = response.origin || store.get().location;
  if (!origin) return;
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
      radius: location.accuracyM || 30,
      color: token(MAP_TOKENS.user),
      fillColor: token(MAP_TOKENS.userHalo),
      fillOpacity: 0.15, weight: 1,
    }).addTo(map);
  } else {
    state.userMarker.setLatLng([location.lat, location.lng]);
    state.accuracyCircle.setLatLng([location.lat, location.lng]).setRadius(location.accuracyM || 30);
  }
}

/* ------------------------------------------------------------- safe route */

export function renderRouteForm() {
  const form = document.getElementById('route-form');
  if (!form || form.dataset.bound === 'true') return;
  form.dataset.bound = 'true';

  const fromInput = document.getElementById('route-from');
  const toInput = document.getElementById('route-to');
  const modeSelect = document.getElementById('route-mode');
  const useCurrent = document.getElementById('route-use-current');
  const error = document.getElementById('route-error');

  const fail = (message) => {
    if (!error) return;
    error.hidden = !message;
    error.textContent = message || '';
  };

  useCurrent?.addEventListener('click', () => {
    const location = store.get().location;
    if (!location) {
      fail('No position yet. Enable location on the dashboard first, or type the coordinates.');
      return;
    }
    fail(null);
    fromInput.value = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const from = parseInto(fromInput);
    const to = parseInto(toInput);
    if (!from || !to) {
      fail('Enter both points as "latitude, longitude", for example 28.6328, 77.2197.');
      return;
    }
    fail(null);
    await planRoutes({ from, to, mode: modeSelect.value });
  });
}

function parseInto(input) {
  const raw = (input.value || '').trim();
  const match = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

export async function planRoutes({ from, to, mode = 'walk' }) {
  const listTarget = document.getElementById('route-results');
  await loadInto(listTarget, async () => {
    const response = await api.routes({ fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng, mode });
    renderRouteList(listTarget, response);
    renderRouteMap(document.getElementById('route-map'), response);
    return response;
  }, { rows: 3 });
}

/** True when the engine has too little real data to rank the options. */
function thinCoverage(routes) {
  if (!routes.length) return true;
  const confidences = routes.map((r) => Number(r.confidence || 0));
  const max = Math.max(...confidences);
  const spread = Math.max(...routes.map((r) => Number(r.safetyScore || 0))) - Math.min(...routes.map((r) => Number(r.safetyScore || 0)));
  return max < 0.3 || spread < 2;
}

function renderRouteList(target, response) {
  const routes = response.routes || [];
  const simulated = response.provenance?.provider === 'simulated_geometric';

  if (!routes.length) {
    mount(target, card('No route', { body: [notice('caution', 'No route found', response.disclaimer || 'SheSafe could not build a route between those points.')] }));
    return;
  }

  const fastest = routes.reduce((best, r) => (!best || r.durationMin < best.durationMin ? r : best), null);
  const safest = routes.reduce((best, r) => (!best || r.safetyScore > best.safetyScore ? r : best), null);
  const balanced = pickBalanced(routes, fastest, safest);
  const thin = thinCoverage(routes);

  mount(target,
    card(null, {
      body: [
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title' }, 'Compare'),
            el('p', { class: 'card__hint' }, 'Three options, scored at nine points along each corridor.')),
          pill(simulated ? 'SIMULATED routes' : 'Real road routes', simulated ? 'simulated' : 'safe')),
        metricGrid([
          metric('Options', String(routes.length)),
          metric('Safety spread', `${Math.round(safetySpread(routes))} pts`),
          metric('Best confidence', `${Math.round(Math.max(...routes.map((r) => Number(r.confidence || 0))) * 100)}%`),
        ]),
        thin
          ? notice('caution', 'Limited safety data available',
            'These routes differ mostly in distance, not in measured safety. SheSafe will not claim one is safer without data to support it.')
          : null,
        response.disclaimer ? el('p', { class: 'small' }, response.disclaimer) : null,
      ],
    }),
    ...routes.map((route) => routeCard(route, { fastest, safest, balanced })));
}

/** Pick the option that trades a little time for a meaningful safety gain. */
function pickBalanced(routes, fastest, safest) {
  if (!fastest || !safest) return routes[0];
  let best = null;
  let bestScore = -Infinity;
  for (const route of routes) {
    const timeCost = fastest.durationMin > 0 ? (route.durationMin - fastest.durationMin) / Math.max(1, fastest.durationMin) : 0;
    const gain = (route.safetyScore - fastest.safetyScore) / 10;
    const score = gain - timeCost * 1.5;
    if (score > bestScore) { bestScore = score; best = route; }
  }
  return best || fastest;
}

const safetySpread = (routes) => Math.max(...routes.map((r) => Number(r.safetyScore || 0))) - Math.min(...routes.map((r) => Number(r.safetyScore || 0)));

function routeCard(route, { fastest, safest, balanced }) {
  const primary = (route.labels || [])[0] || 'ALTERNATIVE';
  const extraMinutes = fastest ? Math.round(route.durationMin - fastest.durationMin) : 0;

  return el('article', {
    class: 'card route-card',
    dataset: { routeId: route.id, label: primary.toLowerCase(), colour: primary },
  },
    el('div', { class: 'route-card__bar' }),
    el('div', { class: 'route-card__body' },
      el('div', { class: 'card__head' },
        el('div', {},
          el('div', { class: 'row row--tight' },
            ...(route.labels || []).map((label) => pill(label, labelTone(label)))),
          el('h3', { class: 'card__title', dataset: { pad: 'top' } }, route.label || primary)),
        el('div', { class: 'route-card__score' },
          el('div', { class: 'route-card__number' }, String(route.safetyScore)),
          // `band` is a RISK band (LOW risk = good), the number above it is a
          // SAFETY score. Printing the bare band under the number reads as
          // "safety 82 / LOW", which is the opposite of the truth.
          el('div', { class: 'small' }, `${route.band} risk`))),

      metricGrid([
        metric('ETA', Math.round(route.durationMin), { unit: 'min' }),
        metric('Distance', route.distanceKm.toFixed(1), { unit: 'km' }),
        metric('vs fastest', extraMinutes > 0 ? `+${extraMinutes}` : '0', { unit: 'min', tone: extraMinutes > 0 ? 'caution' : 'safe' }),
        metric('Confidence', `${Math.round(route.confidence * 100)}`, { unit: '%' }),
      ]),

      el('p', { class: 'small' }, tradeOffLine(route, { fastest, safest, balanced })),

      (route.whySafer || []).length
        ? disclosure('Why this route differs', dataList((route.whySafer || []).map((reason) =>
            dataRow({ iconName: 'info', title: reason }))))
        : null,

      el('a', {
        class: 'btn btn--primary btn--block',
        href: `https://www.google.com/maps/dir/?api=1&origin=${route.geometry[0][0]},${route.geometry[0][1]}&destination=${route.geometry.at(-1)[0]},${route.geometry.at(-1)[1]}&travelmode=${route.mode === 'drive' ? 'driving' : route.mode === 'cycle' ? 'bicycling' : 'walking'}`,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, icon('navigate'), 'Navigate this route')));
}

const labelTone = (label) => ({ SAFEST: 'safe', FASTEST: 'info', BALANCED: 'brand' }[label] || 'neutral');

function routeColour(primary) {
  return token((ROUTE_TOKENS[primary] || '--route-alternative'));
}

function tradeOffLine(route, { fastest, safest, balanced }) {
  const extra = fastest ? Math.round(route.durationMin - fastest.durationMin) : 0;
  const gain = fastest ? Math.round(route.safetyScore - fastest.safetyScore) : 0;
  const time = extra <= 0 ? 'No extra time' : `Adds ${extra} minute${extra === 1 ? '' : 's'}`;
  if (route.id === safest?.id && fastest && route.id !== fastest.id) {
    return `${time} and scores ${gain} points safer than the fastest option.`;
  }
  if (route.id === fastest?.id && gain < 0) {
    return `Fastest option, but ${Math.abs(gain)} points lower on modelled safety than the safest option.`;
  }
  if (route.id === balanced?.id && route.id !== fastest?.id && route.id !== safest?.id) {
    return `${time} for ${gain} points of safety — the middle trade-off.`;
  }
  return `${time}. Modelled safety is ${gain >= 0 ? `${gain} points above` : `${Math.abs(gain)} points below`} the fastest option.`;
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
    const primary = (route.labels || [])[0] || 'ALTERNATIVE';
    const polyline = window.L.polyline(route.geometry, {
      color: routeColour(primary), weight: 5, opacity: 0.9,
      dashArray: primary === 'FASTEST' ? null : '10 8', lineJoin: 'round',
    }).addTo(state.routeMap);
    polyline.bindPopup(popupNode(`${primary} · safety ${route.safetyScore}/100 · ${Math.round(route.durationMin)} min`));
    state.routeLayers.layers.push(polyline);
    bounds.push(polyline.getBounds());
  }
  if (bounds.length) {
    state.routeMap.fitBounds(bounds.reduce((acc, b) => acc.extend(b), bounds[0]), { padding: [24, 24] });
  }
}

function popupNode(text) {
  const box = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = text;
  box.appendChild(strong);
  return box;
}
