/**
 * Leaflet map helper.
 *
 * Wraps tile loading, the SheSafe marker styles, and the safe popup builder.
 * Popups are built with DOM nodes, never with interpolated HTML strings, so a
 * place name from OpenStreetMap can never inject markup.
 */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; OpenStreetMap contributors';

/**
 * Read a colour from the design tokens.
 *
 * Leaflet needs concrete colour strings, so the palette lives in CSS and is read
 * once here. Hard-coding hex values in the client was one of the Phase 2 audit
 * findings: it duplicated the design system and drifted from it in dark mode.
 */
const tokenCache = new Map();

export function token(name, fallback = 'currentColor') {
  if (tokenCache.has(name)) return tokenCache.get(name);
  let value = '';
  try {
    value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    value = '';
  }
  const resolved = value || fallback;
  tokenCache.set(name, resolved);
  return resolved;
}

export const MAP_TOKENS = {
  trail: '--map-trail',
  accuracy: '--map-accuracy',
  accuracyFill: '--map-accuracy-fill',
  user: '--map-user',
  userHalo: '--map-user-halo',
};

/** One vocabulary: an icon name plus the token that colours it. */
export const CATEGORY_STYLE = {
  police: { iconName: 'shield', token: '--poi-police', label: 'Police' },
  hospital: { iconName: 'hospital', token: '--poi-hospital', label: 'Hospital' },
  pharmacy: { iconName: 'pill', token: '--poi-pharmacy', label: 'Pharmacy' },
  shelter: { iconName: 'home', token: '--poi-shelter', label: 'Shelter' },
  women_centre: { iconName: 'community', token: '--poi-women', label: "Women's support" },
  emergency_service: { iconName: 'siren', token: '--poi-emergency', label: 'Emergency service' },
  safe_public: { iconName: 'building', token: '--poi-public', label: 'Safe public place' },
};

export const ROUTE_TOKENS = {
  FASTEST: '--route-fastest',
  SAFEST: '--route-safest',
  BALANCED: '--route-balanced',
  ALTERNATIVE: '--route-alternative',
};

export function isLeafletAvailable() {
  return typeof window.L !== 'undefined' && typeof window.L.map === 'function';
}

export function createMap(node, { center = [28.6328, 77.2197], zoom = 14 } = {}) {
  if (!isLeafletAvailable() || !node) return null;
  const map = window.L.map(node, { zoomControl: true, attributionControl: true });
  window.L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
  map.setView(center, zoom);
  return map;
}

export function userIcon(incident = false) {
  return window.L.divIcon({
    className: `user-pin${incident ? ' user-pin--incident' : ''}`,
    html: '<span class="user-pin__pulse"></span><span class="user-pin__core"></span>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

export function poiIcon(category) {
  const style = CATEGORY_STYLE[category] || { iconName: 'pin', token: '--poi-default' };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[style.iconName] || ICON_PATHS.pin);
  svg.appendChild(path);

  const wrapper = document.createElement('span');
  wrapper.className = 'poi-pin';
  wrapper.style.background = token(style.token);
  wrapper.appendChild(svg);
  return window.L.divIcon({ className: '', html: wrapper.outerHTML, iconSize: [28, 28], iconAnchor: [14, 14] });
}

/** Path data mirrored from ./ui.js so mapkit stays dependency-free. */
const ICON_PATHS = {
  pin: 'M12 21s7-5.6 7-11a7 7 0 10-14 0c0 5.4 7 11 7 11z M12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  shield: 'M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3z',
  hospital: 'M4 21V8l8-4 8 4v13M12 10v6M9 13h6',
  pill: 'M8.5 3.5a5 5 0 017 7l-5 5a5 5 0 01-7-7l5-5zM6 6l7 7',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4v-9z',
  community: 'M3 11l9-7 9 7M5 10v10h14V10M9 20v-6h6v6',
  siren: 'M7 18v-5a5 5 0 0110 0v5M4 18h16M5 21h14M12 3v2',
  building: 'M4 21V6l7-3v18M11 21h9V10l-9-3M7 9v.01M7 13v.01M7 17v.01M15 13v.01M15 17v.01',
};

export function placePopup(place) {
  const wrap = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = place.name;
  const meta = document.createElement('div');
  meta.className = 'map-popup__meta';

  const bits = [place.distanceText];
  if (place.openState === 'open') bits.push('Open now (per OpenStreetMap tag)');
  if (place.openState === 'closed') bits.push('Tagged closed');
  if (place.etaMinutesWalk) bits.push(`${place.etaMinutesWalk} min walk`);
  meta.textContent = bits.join(' · ');

  const links = document.createElement('div');
  links.className = 'map-popup__actions';

  const navigate = document.createElement('a');
  navigate.className = 'map-popup__action';
  navigate.href = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
  navigate.target = '_blank';
  navigate.rel = 'noopener noreferrer';
  navigate.textContent = 'Navigate';
  links.appendChild(navigate);

  if (place.phone) {
    const call = document.createElement('a');
    call.className = 'map-popup__action map-popup__action--call';
    call.href = `tel:${String(place.phone).replace(/[^+\d]/g, '')}`;
    call.textContent = 'Call';
    links.appendChild(call);
  }

  wrap.append(name, meta, links);

  if (place.provenance === 'simulated_demo_dataset') {
    const tag = document.createElement('div');
    tag.className = 'map-popup__simulated';
    tag.textContent = 'SIMULATED DEMO DATA';
    wrap.appendChild(tag);
  }
  return wrap;
}

export function clearLayer(map, layerHolder) {
  if (!map || !layerHolder) return;
  for (const layer of layerHolder.layers) {
    try { map.removeLayer(layer); } catch { /* already removed */ }
  }
  layerHolder.layers.length = 0;
}

export function invalidate(map) {
  if (map && typeof map.invalidateSize === 'function') {
    window.setTimeout(() => map.invalidateSize(), 60);
  }
}