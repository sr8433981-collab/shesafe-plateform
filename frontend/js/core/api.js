/**
 * API client.
 *
 * Three properties matter here:
 *
 * 1. **It never fabricates a success.** The audited build caught every error -
 *    including a legitimate 401 - and returned a canned local object, which made
 *    authentication meaningless and lost emergency records during a network
 *    blip. Here, an error is an error. There is no silent fallback to
 *    `localStorage` pretending the write succeeded.
 * 2. **CSRF double-submit.** Every state-changing request echoes the readable
 *    `shesafe_csrf` cookie in the `X-CSRF-Token` header.
 * 3. **One error shape.** `ApiError` always carries the server's code, message
 *    and request id so the UI can show something honest.
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network_error', requestId = null, fields = null, offline = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.fields = fields;
    this.offline = offline;
  }

  get isAuth() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isRateLimited() { return this.status === 429; }
  get isOffline() { return this.offline || this.status === 0; }
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/([.$?*|{}()[\]\\/+^=])/g, '\\$1')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function request(path, { method = 'GET', body = null, signal = null, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const headers = { Accept: 'application/json' };
  if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCookie('shesafe_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === null || body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    window.clearTimeout(timer);
    throw new ApiError(
      'Cannot reach the SheSafe server. Check your connection and try again.',
      { status: 0, code: 'network_error', offline: true },
    );
  }
  window.clearTimeout(timer);

  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }

  if (!response.ok) {
    const error = (payload && payload.error) || {};
    throw new ApiError(error.message || `Request failed (HTTP ${response.status}).`, {
      status: response.status,
      code: error.code || `http_${response.status}`,
      requestId: (payload && payload.request_id) || response.headers.get('X-Request-ID'),
      fields: error.fields || (error.reference ? { reference: error.reference } : null),
    });
  }

  return payload || {};
}

function qs(params) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  get: (path, params, opts) => request(`${path}${qs(params)}`, { method: 'GET', ...opts }),
  post: (path, body, opts) => request(path, { method: 'POST', body: body ?? {}, ...opts }),
  patch: (path, body, opts) => request(path, { method: 'PATCH', body: body ?? {}, ...opts }),
  delete: (path, opts) => request(path, { method: 'DELETE', ...opts }),

  // --- typed endpoints --------------------------------------------------
  session: () => request('/auth/session', { method: 'GET' }),
  login: (identifier, password) => request('/auth/login', { method: 'POST', body: { identifier, password } }),
  signup: (payload) => request('/auth/signup', { method: 'POST', body: payload }),
  logout: () => request('/auth/logout', { method: 'POST', body: {} }),
  updateProfile: (payload) => request('/auth/profile', { method: 'PATCH', body: payload }),

  health: () => request('/health'),
  capabilities: () => request('/capabilities'),
  helplines: () => request('/helplines'),

  listContacts: () => request('/contacts'),
  addContact: (payload) => request('/contacts', { method: 'POST', body: payload }),
  updateContact: (id, payload) => request(`/contacts/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
  deleteContact: (id) => request(`/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  verifyContact: (id) => request(`/contacts/${encodeURIComponent(id)}/verify`, { method: 'POST', body: {} }),

  sosLifecycle: () => request('/sos/lifecycle'),
  armSos: (triggerSource = 'button') => request('/sos/arm', { method: 'POST', body: { triggerSource } }),
  activateSos: (position) => request('/sos/activate', { method: 'POST', body: position }),
  escalateSos: () => request('/sos/escalate', { method: 'POST', body: {} }),
  resolveSos: (note) => request('/sos/resolve', { method: 'POST', body: { note } }),
  cancelSos: (reason) => request('/sos/cancel', { method: 'POST', body: { reason } }),
  activeIncident: () => request('/sos/active'),
  incidents: (limit = 20) => request(`/sos/incidents${qs({ limit })}`),

  pingLocation: (position) => request('/location/ping', { method: 'POST', body: position }),
  latestLocation: () => request('/location/latest'),
  startSharing: (options = {}) => request('/location/share/start', { method: 'POST', body: options }),
  activeShares: () => request('/location/share/active'),
  revokeSharing: (shareId) => request('/location/share/revoke', { method: 'POST', body: shareId ? { shareId } : {} }),
  track: (token) => request(`/track/${encodeURIComponent(token)}`),

  assess: (params) => request(`/intelligence/assess${qs(params)}`),
  explain: () => request('/intelligence/explain'),
  places: (params) => request(`/intelligence/places${qs(params)}`),
  routes: (payload) => request('/intelligence/routes', { method: 'POST', body: payload }),
  incidentAssist: (description) => request('/intelligence/incident-assist', { method: 'POST', body: { description } }),

  journeys: () => request('/journeys'),
  activeJourney: () => request('/journeys/active'),
  startJourney: (payload) => request('/journeys', { method: 'POST', body: payload }),
  checkInJourney: (id, note) => request(`/journeys/${encodeURIComponent(id)}/checkin`, { method: 'POST', body: { note } }),
  cancelJourney: (id) => request(`/journeys/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  escalateJourney: (id) => request(`/journeys/${encodeURIComponent(id)}/escalate`, { method: 'POST', body: {} }),

  checkIns: () => request('/checkins'),
  postCheckIn: (payload) => request('/checkins', { method: 'POST', body: payload }),
  reports: (params) => request(`/reports${qs(params)}`),
  createReport: (payload) => request('/reports', { method: 'POST', body: payload }),
  helpfulReport: (id) => request(`/reports/${encodeURIComponent(id)}/helpful`, { method: 'POST', body: {} }),
  moderateReport: (id, payload) => request(`/reports/${encodeURIComponent(id)}/moderate`, { method: 'POST', body: payload }),

  demoStatus: () => request('/demo/status'),
  demoScript: () => request('/demo/script'),
  demoReset: () => request('/demo/reset', { method: 'POST', body: {} }),
};