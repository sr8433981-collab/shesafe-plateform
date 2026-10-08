/**
 * Leaflet map helper.
 *
 * Wraps tile loading, the SheSafe marker styles, and the safe popup builder.
 * Popups are built with DOM nodes, never with interpolated HTML strings, so a
 * place name from OpenStreetMap can never inject markup.
 */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; OpenStreetMap contributors';

export const CATEGORY_STYLE = {
  police: { glyph: '👮', color: '#e11d48', label: 'Police' },
  hospital: { glyph: '🏥', color: '#2563eb', label: 'Hospital' },
  pharmacy: { glyph: '💊', color: '#059669', label: 'Pharmacy' },
  shelter: { glyph: '🏠', color: '#7c3aed', label: 'Shelter' },
  women_centre: { glyph: '🌸', color: '#db2777', label: "Women's support" },
  emergency_service: { glyph: '🚨', color: '#dc2626', label: 'Emergency service' },
  safe_public: { glyph: '💡', color: '#0891b2', label: 'Safe public place' },
};

export const ROUTE_COLORS = {
  FASTEST: '#2563eb',
  SAFEST: '#059669',
  BALANCED: '#7c3aed',
  ALTERNATIVE: '#94a3b8',
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
  const style = CATEGORY_STYLE[category] || { glyph: '•', color: '#475569' };
  return window.L.divIcon({
    className: '',
    html: `<span class="poi-pin" style="background:${style.color}">${style.glyph}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

export function placePopup(place) {
  const wrap = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = place.name;
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:0.78rem;color:#64748b;margin:2px 0 6px';

  const bits = [place.distanceText];
  if (place.openState === 'open') bits.push('Open now (per OpenStreetMap tag)');
  if (place.openState === 'closed') bits.push('Tagged closed');
  if (place.etaMinutesWalk) bits.push(`${place.etaMinutesWalk} min walk`);
  meta.textContent = bits.join(' · ');

  const links = document.createElement('div');
  links.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

  const navigate = document.createElement('a');
  navigate.href = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
  navigate.target = '_blank';
  navigate.rel = 'noopener noreferrer';
  navigate.textContent = 'Navigate';
  navigate.style.cssText =
    'font-size:0.78rem;font-weight:700;padding:4px 10px;border-radius:999px;background:#059669;color:#fff;text-decoration:none';
  links.appendChild(navigate);

  if (place.phone) {
    const call = document.createElement('a');
    call.href = `tel:${String(place.phone).replace(/[^+\d]/g, '')}`;
    call.textContent = 'Call';
    call.style.cssText =
      'font-size:0.78rem;font-weight:700;padding:4px 10px;border-radius:999px;background:#2563eb;color:#fff;text-decoration:none';
    links.appendChild(call);
  }

  wrap.append(name, meta, links);

  if (place.provenance === 'simulated_demo_dataset') {
    const tag = document.createElement('div');
    tag.style.cssText = 'margin-top:6px;font-size:0.68rem;font-weight:800;color:#92400e;letter-spacing:0.05em';
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