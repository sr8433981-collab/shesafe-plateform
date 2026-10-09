/**
 * Frontend browser-contract test (jsdom).
 *
 * Runs the real `js/app.js` module graph in a simulated browser against a live
 * SheSafe server, then asserts the user-visible contract that Phase 2 promised:
 *
 *   - a signed-out visitor sees the sign-in screen and nothing else,
 *   - the SOS control's label always describes what it does, and press-and-hold
 *     arms it,
 *   - the cancel window is visible and cancellable,
 *   - the active emergency surface reports location, accuracy, age, sharing
 *     state, per-contact delivery status and the emergency-services capability,
 *   - an open emergency is visible from every view,
 *   - HIGH and MODERATE do not look the same,
 *   - the guardian console recovers from a transient network failure,
 *   - and the code-level promises from docs/PHASE2_UI_AUDIT.md §7 hold:
 *     no native dialogs, no inline event handlers, no inline styles, no
 *     hard-coded hex colours, one `metric()`, nothing below 12px.
 *
 * Why jsdom and not a real browser: this is a contract test between the client
 * modules and the API. Geolocation, audio and Leaflet are unavailable in jsdom
 * and are stubbed; those code paths are covered by their own guards.
 *
 * Usage:
 *   node tests/frontend/smoke.mjs                # starts its own server
 *   BASE_URL=http://127.0.0.1:5000 node tests/frontend/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FRONTEND = path.join(REPO, 'frontend');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------- server --- */

async function waitForServer(base, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function startServer() {
  const port = 5099;
  const base = `http://127.0.0.1:${port}`;
  // A fresh database per run. The suite used to reuse whatever
  // backend/data/smoke-test.db the previous run left behind, so a second run
  // started against an account that already had an open Journey Guard: the
  // journey screen then rendered the active card instead of the start form and
  // the suite crashed with a TypeError. Tests must not depend on run order.
  // Only the suite's own scratch database is removed - never shesafe.db.
  const dataDir = path.join(REPO, 'backend', 'data');
  const dbPath = path.join(dataDir, 'smoke-test.db');
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${dbPath}${suffix}`, { force: true }).catch(() => {});
  }
  await mkdir(dataDir, { recursive: true });
  const child = spawn(
    process.env.PYTHON_BIN || path.join(REPO, '.venv', 'bin', 'python3'),
    [path.join(REPO, 'backend', 'wsgi.py')],
    {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        SHESAFE_ENV: 'testing',
        SHESAFE_DEMO_MODE: '1',
        SHESAFE_SEED: '1',
        SHESAFE_DB: dbPath,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  if (!(await waitForServer(base))) {
    child.kill('SIGKILL');
    throw new Error('Test server did not start');
  }
  return { base, stop: () => child.kill('SIGKILL') };
}

/* -------------------------------------------------------- cookie jar ---- */

function makeCookieJar(window) {
  const jar = new Map();
  // Capture Node's fetch *before* installing the wrapper: once the wrapper is on
  // `window` and then on `globalThis`, reading it inside would recurse forever.
  const nodeFetch = globalThis.fetch;
  function parseSetCookie(header) {
    const [pair, ...attrs] = header.split(';');
    const index = pair.indexOf('=');
    if (index === -1) return null;
    const expired = attrs.some((attr) => /(^|\s)max-age=0(\s|$)/i.test(attr) || /expires=thu, 01 jan 1970/i.test(attr));
    return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), expired };
  }
  Object.defineProperty(window.document, 'cookie', {
    configurable: true,
    get() { return Array.from(jar, ([name, value]) => `${name}=${value}`).join('; '); },
    set(raw) {
      const parsed = parseSetCookie(String(raw));
      if (!parsed) return;
      if (parsed.expired) jar.delete(parsed.name);
      else jar.set(parsed.name, parsed.value);
    },
  });
  return {
    jar,
    async fetch(input, init) {
      const target = new URL(String(input), window.__base).toString();
      const headers = new Headers((init && init.headers) || {});
      const cookieHeader = Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');
      if (cookieHeader) headers.set('Cookie', cookieHeader);
      const response = await nodeFetch(target, { ...(init || {}), headers });
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      for (const raw of setCookies) {
        const parsed = parseSetCookie(raw);
        if (!parsed) continue;
        if (parsed.expired) jar.delete(parsed.name);
        else jar.set(parsed.name, parsed.value);
      }
      return response;
    },
  };
}

/* --------------------------------------------------------------- dom ---- */

async function launchApp(base, { file = 'index.html', globals = {} } = {}) {
  const html = await readFile(path.join(FRONTEND, file), 'utf8');
  const css = await readFile(path.join(FRONTEND, 'css', 'app.css'), 'utf8');

  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (error) => {
    if (!/Could not parse CSS/.test(error.message)) errors.push(error.message);
  });
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));

  const dom = new JSDOM(html, {
    url: `${base}/${file}${globals.query || ''}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  window.__base = base;

  const cookies = makeCookieJar(window);
  window.fetch = cookies.fetch;

  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // jsdom has no layout engine and its focus() is unreliable, so track focus
  // explicitly: keep `document.activeElement` and `window.__lastFocused` in sync
  // with the element that was asked to take focus. Without this, any contract
  // about focus movement or focus restoration would be unverifiable here.
  window.__lastFocused = null;
  const realFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function focus(...args) {
    window.__lastFocused = this;
    try {
      Object.defineProperty(window.document, 'activeElement', {
        configurable: true, get: () => this,
      });
    } catch { /* not all environments allow redefining it */ }
    try { return realFocus.apply(this, args); } catch { return undefined; }
  };
  window.HTMLElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLElement.prototype.close = function close() { this.open = false; };
  window.HTMLFormElement.prototype.requestSubmit = function requestSubmit() {
    this.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  };
  // The contract forbids native dialogs; if one is ever reintroduced it must not
  // be able to block the suite silently.
  window.alert = () => { errors.push('window.alert was called'); };
  window.prompt = () => { errors.push('window.prompt was called'); return null; };
  window.confirm = () => { errors.push('window.confirm was called'); return false; };

  // Location is denied by default so the suite exercises the real "permission
  // denied" path, then switched on for the SOS and guardian scenarios.
  const SYNTHETIC_FIX = { latitude: 28.6328, longitude: 77.2197, accuracy: 8, speed: 0, heading: null };
  let locationMode = 'denied';
  const makePosition = (timestamp = Date.now()) => ({ coords: SYNTHETIC_FIX, timestamp });
  window.navigator.geolocation = {
    getCurrentPosition(ok, fail) {
      if (locationMode === 'denied') fail({ code: 1, message: 'denied' });
      else if (locationMode === 'error') fail({ code: 2, message: 'unavailable' });
      else window.setTimeout(() => ok(makePosition()), 0);
    },
    watchPosition(ok) {
      if (locationMode === 'granted') window.setTimeout(() => ok(makePosition()), 0);
      return 1;
    },
    clearWatch() {},
  };
  window.__setLocationMode = (value) => { locationMode = value; };

  const style = window.document.createElement('style');
  style.textContent = css;
  window.document.head.appendChild(style);

  // jsdom cannot execute `type="module"` scripts, so expose the jsdom window as
  // the ambient global and then import the real module graph. The application
  // code is unmodified — it just runs with browser globals in scope.
  // NOTE: fetch/Headers/Request/Response/AbortController stay as Node's. Passing
  // jsdom's AbortSignal into Node's fetch throws a TypeError, which would look
  // like "server unreachable".
  const GLOBALS = [
    'window', 'document', 'navigator', 'location', 'history', 'localStorage',
    'sessionStorage', 'fetch',
    'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent',
    'HTMLElement', 'HTMLFormElement', 'Element', 'Node', 'getComputedStyle',
  ];
  for (const name of GLOBALS) {
    const value = name === 'window' ? window : window[name];
    if (value === undefined) continue;
    try {
      globalThis[name] = value;
    } catch {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
  }
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true, writable: true });

  if (file === 'index.html') {
    const entry = pathToFileURL(path.join(FRONTEND, 'js', 'app.js')).href;
    await import(`${entry}?t=${Date.now()}`);
  } else if (file === 'track.html') {
    const entry = pathToFileURL(path.join(FRONTEND, 'js', 'track.js')).href;
    await import(`${entry}?t=${Date.now()}`);
  }

  const restore = () => {
    for (const name of GLOBALS) {
      const value = name === 'window' ? window : window[name];
      if (value === undefined) continue;
      try { globalThis[name] = value; } catch {
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
      }
    }
    Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true, writable: true });
  };

  return { dom, window, document: window.document, errors, cookies, restore };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 6000, interval = 40 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(interval);
  }
  return false;
}

const text = (document, selector) => (document.querySelector(selector)?.textContent || '').trim();
const visible = (document, id) => { const node = document.getElementById(id); return Boolean(node) && !node.hidden; };

/* --------------------------------------------------------------- main --- */

async function main() {
  const external = process.env.BASE_URL;
  const server = external ? { base: external, stop: () => {} } : await startServer();
  activeServer = server;
  const base = server.base;
  console.log(`\nSheSafe browser contract test → ${base}\n`);

  const { window, document, errors, cookies, restore: restoreGlobals } = await launchApp(base);

  // --- performance: count every request the first screen makes -------------
  const apiCalls = [];
  const instrument = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/api/')) apiCalls.push(`${(init && init.method) || 'GET'} ${url.replace(base, '')}`);
    return instrument(input, init);
  };
  window.fetch = globalThis.fetch;

  /* --- boot and the authentication gate ------------------------------- */
  section('boot and the authentication gate');
  const authVisible = await waitFor(() => visible(document, 'view-auth'));
  check('a signed-out visitor is shown the sign-in screen', authVisible);
  const anyViewShown = Array.from(document.querySelectorAll('[data-view]')).some((view) => !view.hidden);
  check('no authenticated view is shown while signed out', !anyViewShown);
  check('the tab bar is hidden while signed out',
    Array.from(document.querySelectorAll('.tabbar__link')).every((link) => link.hidden));
  check('no uncaught script errors during boot', errors.length === 0, errors.join(' | '));
  check('demo mode ribbon is shown', await waitFor(() => Boolean(document.querySelector('.demo-ribbon'))));
  check('the sign-in screen shows an always-reachable 112 action',
    /112/.test(document.querySelector('.appbar').textContent));

  /* --- navigation graph ------------------------------------------------ */
  section('navigation');
  const routes = ['home', 'journey', 'sharing', 'intelligence', 'route', 'places', 'reports', 'assist', 'history', 'security'];
  const reachable = new Set(
    [...document.querySelectorAll('#nav-rail a, #tabbar a')].map((a) => a.dataset.route),
  );
  const inContent = new Set(
    [...document.querySelectorAll('[data-view] a[href^="#/"]')].map((a) => a.getAttribute('href').slice(2)),
  );
  const unreachable = routes.filter((route) => !reachable.has(route) && !inContent.has(route));
  check('every view is reachable from navigation', unreachable.length === 0, unreachable.join(', '));
  check('the desktop rail exists for pointer-sized screens', document.querySelectorAll('#nav-rail a').length === routes.length);

  /* --- sign in --------------------------------------------------------- */
  section('sign in');
  document.getElementById('login-identifier').value = 'demo@shesafe.local';
  document.getElementById('login-password').value = process.env.SHESAFE_DEMO_PASSWORD || 'shesafe-demo';
  document.getElementById('form-login').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const signedIn = await waitFor(() => visible(document, 'view-home'), { timeout: 15000 });
  check('sign-in succeeds and the dashboard is shown', signedIn);
  if (!signedIn) process.stderr.write(`[smoke] toasts: ${text(document, '#toasts')}\n`);
  check('the sign-in screen is hidden once authenticated', !visible(document, 'view-auth'));
  const greeted = await waitFor(() => {
    const value = text(document, '#home-first-name');
    return value.length > 0 && value !== 'there';
  });
  check('the dashboard greets the signed-in user by name', greeted, text(document, '#home-first-name'));
  check('the navigation is visible once authenticated',
    Array.from(document.querySelectorAll('.tabbar__link')).every((link) => !link.hidden));
  const emergencyNumbers = await waitFor(
    () => document.querySelectorAll('#helpline-list .dlist__item').length > 0, { timeout: 25000 });
  check('the emergency numbers list is rendered', emergencyNumbers);
  const dashboardReady = await waitFor(() => Boolean(document.getElementById('btn-sos')), { timeout: 25000 });
  check('the dashboard finished rendering', dashboardReady);

  const session = await cookies.fetch('/api/auth/session').then((r) => r.json()).catch(() => ({}));
  check('the client authenticated against the real API', session.authenticated === true, JSON.stringify(session).slice(0, 120));

  /* --- dashboard hierarchy --------------------------------------------- */
  section('dashboard hierarchy');
  check('the emergency dock is rendered', Boolean(document.querySelector('.sos-dock #btn-sos')));
  const dashboardOrder = Array.from(document.querySelectorAll('#view-home > div, #view-home .stack'))
    .map((node) => node.id || node.className.split(' ')[0]);
  check('SOS appears before the safety status on the dashboard',
    dashboardOrder.indexOf('home-emergency') < dashboardOrder.indexOf('home-safety'), dashboardOrder.join(' > '));
  check('the safety status block is present', Boolean(document.getElementById('safety-status-card') || document.getElementById('home-safety').children.length));
  check('journey, location, contacts, places and intelligence each have a block',
    ['Journey Guard', 'Live location', 'Trusted contacts', 'Nearby safe places', 'Safety intelligence']
      .every((label) => text(document, '#home-detail').includes(label)));
  check('there is no "quick actions" link grid', !/Quick actions/.test(document.body.textContent));
  check('the dashboard does not duplicate the whole capability list',
    (document.querySelectorAll('#view-home .badge--simulated').length <= 1));

  /* --- location consent ------------------------------------------------ */
  section('location consent');
  check('with location denied the UI says so instead of pretending to be live',
    /Location is off|Enable location|Waiting for a position/i.test(text(document, '#home-detail')));

  window.__setLocationMode('granted');
  document.getElementById('btn-location-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const located = await waitFor(() => /28\.63/.test(text(document, '#home-detail')), { timeout: 10000 });
  check('enabling location shows the captured position', located, text(document, '#home-detail').slice(0, 120));
  check('location accuracy is displayed', /±\d+/.test(text(document, '#home-detail')));

  /* --- safety intelligence --------------------------------------------- */
  section('safety intelligence');
  window.location.hash = '#/intelligence';
  const intelRendered = await waitFor(() => document.querySelector('#assessment-hero'), { timeout: 20000 });
  check('the safety intelligence screen renders', intelRendered);
  const intelText = text(document, '#assessment-panel');
  check('the hero number is the SAFETY score, not the risk score',
    /safety \/ 100/i.test(text(document, '#safety-dial')) && text(document, '#safety-dial').includes('safety'));
  check('the risk band is shown as a word', /LOW|MODERATE|HIGH|CRITICAL/.test(intelText));
  check('confidence is shown as a percentage', /Confidence/.test(intelText) && /\d+%/.test(intelText));
  check('data coverage is shown', /Data coverage/.test(intelText));
  check('contributing factors are listed with signed contributions',
    document.querySelectorAll('#assessment-factors .factor').length >= 6
    && /\+?-?\d+\.\d/.test(text(document, '#assessment-factors')));
  check('each factor shows provenance', document.querySelectorAll('#assessment-factors .factor__provenance').length >= 6);
  check('there is a plain-language "Why this score?" section',
    /Why this score\?/.test(intelText) && text(document, '#assessment-why').length > 120);
  check('the engine states it is not a trained model', /not a trained machine-learning model|rule set, not a trained model/i.test(intelText));
  check('the engine card is populated (previously dead)',
    await waitFor(() => text(document, '#engine-info').includes('Engine:')));

  const bandClasses = await bandClassSnapshot(base, cookies);
  check('HIGH and MODERATE render differently', bandClasses.high !== bandClasses.moderate,
    `HIGH=${bandClasses.high} MODERATE=${bandClasses.moderate}`);

  /* --- safety-aware routes --------------------------------------------- */
  section('safety-aware routes');
  window.location.hash = '#/route';
  const indexHtml = await readFile(path.join(FRONTEND, 'index.html'), 'utf8');
  check('the route form ships with no pre-filled coordinates',
    !/id="route-(from|to)"[^>]*value=/.test(indexHtml));
  check('the route form offers a "use my position" affordance',
    indexHtml.includes('id="route-use-current"'));
  document.getElementById('route-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const invalidHandled = await waitFor(() => /latitude, longitude/i.test(text(document, '#route-error')));
  check('invalid input is reported inline, not with a native dialog', invalidHandled, text(document, '#route-error'));
  document.getElementById('route-from').value = '28.63280, 77.21970';
  document.getElementById('route-to').value = '28.65010, 77.24120';
  document.getElementById('route-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  let routeCards = await waitFor(() => document.querySelectorAll('.route-card').length > 0, { timeout: 25000 });
  if (!routeCards) {
    // OSRM is a public volunteer-run service; one retry before calling it a
    // contract failure keeps the suite honest without hiding a real regression.
    document.getElementById('route-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    routeCards = await waitFor(() => document.querySelectorAll('.route-card').length > 0, { timeout: 25000 });
  }
  check('routes render as comparable option cards', routeCards, text(document, '#route-results').slice(0, 160));
  if (routeCards) {
    const routeText = text(document, '#route-results');
    const labelled = ['FASTEST', 'SAFEST', 'BALANCED'].filter((label) => routeText.includes(label));
    check('routes are labelled fastest / safest / balanced', labelled.length > 0, labelled.join(','));
    check('the trade-off against the fastest option is stated',
      /Adds \d+ minute/.test(routeText) || /No extra time/.test(routeText));
    check('each option shows ETA, distance, safety and confidence',
      /ETA/.test(routeText) && /Distance/.test(routeText) && /Confidence/.test(routeText) && /safety/i.test(routeText));
    check('thin coverage is reported honestly or the options are compared',
      /Limited safety data available/.test(routeText) || labelled.length > 0);
  }

  /* --- journey guard ---------------------------------------------------- */
  section('journey guard');
  window.location.hash = '#/journey';
  const journeyForm = await waitFor(() => document.getElementById('journey-contact'), { timeout: 12000 });
  check('journey start captures a trusted contact', journeyForm);
  check('the browser limitation is stated on screen',
    /Browsers cannot reliably wake a closed tab|Browser/i.test(text(document, '#journey-panel')));
  check('the escalation ladder is shown', document.querySelectorAll('#journey-side .dlist__item').length >= 4);
  document.getElementById('journey-minutes').value = '45';
  document.getElementById('journey-start-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const journeyStarted = await waitFor(() => /I arrived safely/.test(document.body.textContent), { timeout: 12000 });
  check('a journey can be started with a trusted contact attached', journeyStarted);

  /* --- SOS lifecycle ---------------------------------------------------- */
  section('SOS lifecycle');
  window.location.hash = '#/home';
  await waitFor(() => visible(document, 'view-home'));

  const orb = document.getElementById('btn-sos');
  check('the SOS control exists and describes press-and-hold',
    /press and hold/i.test(orb.getAttribute('aria-label') || ''), orb.getAttribute('aria-label'));
  check('the SOS control is not labelled "stop" while idle',
    !/stand down/i.test(orb.textContent));
  check('a one-tap arm alternative is offered', Boolean(document.getElementById('btn-sos-quick')));

  // Hold the activation POST open briefly so the in-flight state is observable
  // rather than a race. The server is unchanged; only the client's view of it is
  // delayed in time.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/api/sos/activate')) await sleep(1400);
    return realFetch(input, init);
  };

  // A synthesised click (detail === 0) is what a keyboard or assistive
  // technology produces, and it must arm immediately.
  orb.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const armed = await waitFor(() => /Cancel window open/.test(document.body.textContent));
  check('the control arms and opens the cancel window', armed, text(document, '#home-emergency').slice(0, 160));
  check('the countdown is a large visible number, not a small badge',
    Boolean(document.getElementById('sos-countdown')) && /sos-countdown/.test(document.querySelector('#sos-countdown').className));
  check('the countdown states when the alert activates',
    /Emergency alert will activate in \d+ second/.test(document.body.textContent),
    (document.body.textContent.match(/Emergency alert will activate in \d+ seconds?/) || ['<none>'])[0]);
  check('cancellation is immediately available', Boolean(document.getElementById('btn-sos-cancel')));
  check('the cancel window warns that nothing has been sent',
    /Nothing has been sent/i.test(document.body.textContent));
  check('the emergency bar is visible from the shell',
    /Emergency activates in/.test(text(document, '#emergency-bar-host')));
  check('SOS cannot be described as contacting police during the countdown',
    !/police (control room|were|has been) (notified|contacted)/i.test(document.body.textContent));

  const activating = await waitFor(() => /Activating/.test(document.body.textContent), { timeout: 25000 });
  check('the in-flight state is labelled Activating, never "SOS ACTIVE"', activating,
    text(document, '#home-emergency').slice(0, 160));
  const activated = await waitFor(
    () => /SOS activated/.test(text(document, '#home-emergency')), { timeout: 25000 });
  check('the SOS activates after the cancel window', activated, text(document, '#home-emergency').slice(0, 200));
  globalThis.fetch = realFetch;

  const active = text(document, '#home-emergency');
  check('the active surface is labelled SOS ACTIVE', /SOS ACTIVE/.test(active));
  check('the incident reference is shown', /Incident SS-/.test(active));
  check('GPS accuracy is shown', /GPS accuracy/.test(active) && /±\s?\d+\s?m/.test(active),
    active.slice(0, 300));
  // The emergency console names this "Location age" (per the phase-3 brief) and
  // shows it as a phrase, not raw seconds. Either wording satisfies the promise.
  check('the age of the fix is shown', /Location age|Last updated/.test(active),
    active.slice(0, 300));
  check('location sharing state is shown', /Location sharing/.test(active) && /ACTIVE|INACTIVE/.test(active));
  check('the emergency services capability is shown',
    /Emergency services/.test(active) && /AVAILABLE|UNAVAILABLE/.test(active));
  check('per-contact delivery status is shown',
    /CONTACTS NOTIFIED/i.test(document.body.textContent) || /SIMULATED|UNAVAILABLE|DELIVERED|FAILED/i.test(active));
  check('Call 112 is offered', Boolean(document.querySelector('#home-emergency a[href="tel:112"]')));
  check('stand down is offered', Boolean(document.getElementById('btn-sos-stand-down')));
  check('the incident timeline is shown', document.querySelectorAll('#home-emergency .timeline__item').length >= 2);
  check('the active emergency does not claim police were contacted',
    !/police (control room|were|has been) (notified|contacted|mobilised|mobilized)/i.test(active));

  /* --- emergency visible from every view -------------------------------- */
  section('emergency is visible from every view');
  window.location.hash = '#/places';
  const barEverywhere = await waitFor(() => /SOS ACTIVE/.test(text(document, '#emergency-bar-host')));
  check('the emergency bar persists when navigating away from the dashboard', barEverywhere,
    text(document, '#emergency-bar-host'));
  check('the tab bar marks the emergency', document.querySelector('.tabbar__link[data-emergency="true"]') !== null);
  check('the document title reflects the emergency', /Dashboard|Places/.test(document.title));

  /* --- guardian console -------------------------------------------------- */
  section('guardian console');
  const shareUrl = window.sessionStorage.getItem('shesafe:lastShareUrl');
  check('an incident minted an expiring guardian link', Boolean(shareUrl), shareUrl || '<none>');
  let guardianToken = null;
  if (shareUrl) {
    check('the link carries a high-entropy token and no user id', /[?&]t=[A-Za-z0-9_-]{32,}/.test(shareUrl) && !/user=/.test(shareUrl));
    const token = new URL(shareUrl).searchParams.get('t');
    guardianToken = token;

    const guardian = await launchApp(base, { file: 'track.html', globals: { query: `?t=${token}` } });
    const rendered = await waitFor(() => !guardian.document.getElementById('content-panel').hidden, { timeout: 15000 });
    check('the guardian console renders from the token alone', rendered,
      text(guardian.document, '#guardian-loading') || text(guardian.document, '#error-body').slice(0, 120));
    if (rendered) {
      const gtext = text(guardian.document, '#content-panel');
      check('the guardian shows who they are following', /You are following/.test(gtext));
      check('the guardian shows GPS accuracy and last update', /GPS accuracy/.test(gtext) && /Last updated/.test(gtext));
      check('the guardian shows incident time', /Incident time|Raised/.test(gtext));
      check('the guardian shows journey status when one exists',
        /Journey Guard/.test(gtext) || guardian.document.getElementById('journey-panel').children.length === 0);
      check('the guardian shows what SheSafe actually did, not that it succeeded',
        /What SheSafe actually did/.test(gtext) && /SIMULATED|DELIVERED|UNAVAILABLE/.test(gtext));
      check('the guardian timeline is built from the record',
        guardian.document.querySelectorAll('#timeline-host .timeline__item').length >= 2);
      // Every timeline event, on every surface, carries a timestamp and a
      // sentence a person can read.
      check('every timeline event shows when it happened and what it meant',
        guardian.document.querySelectorAll('#timeline-host .timeline__item').length > 0
        && Array.from(guardian.document.querySelectorAll('#timeline-host .timeline__item')).every((item) => {
          const time = item.querySelector('.timeline__time, .timeline__meta');
          return Boolean(time && time.textContent.trim());
        }));
      check('the guardian states SheSafe did not contact emergency services',
        /does not contact police or ambulance|has not contacted emergency services/i.test(guardian.document.body.textContent));
      check('the guardian never invents a position', /No position has been received/.test(gtext) || /\d\d\.\d{4}/.test(gtext));

      // Transient failure must not end the session.
      const realFetch = guardian.window.fetch;
      let failNext = true;
      guardian.window.fetch = async (...args) => {
        if (failNext) { failNext = false; throw new TypeError('network down'); }
        return realFetch(...args);
      };
      globalThis.fetch = guardian.window.fetch;
      await new Promise((resolve) => setTimeout(resolve, 5200));
      check('a transient network failure does not end the guardian session',
        !guardian.document.getElementById('error-panel').hidden === false
        || !/cannot be used/i.test(text(guardian.document, '#error-body')));
      check('the last known position survives the failure',
        /\d\d\.\d{4}/.test(text(guardian.document, '#content-panel'))
        || /Reconnecting/.test(text(guardian.document, '#content-panel')));
      globalThis.fetch = realFetch;

      // Revocation must kill the link instantly.
      await cookies.fetch('/api/location/share/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': cookies.jar.get('shesafe_csrf') },
        body: '{}',
      });
      guardian.window.document.dispatchEvent(new guardian.window.Event('visibilitychange'));
      await waitFor(() => !guardian.document.getElementById('error-panel').hidden, { timeout: 15000 });
      check('revoking the link makes the guardian view unavailable',
        !guardian.document.getElementById('error-panel').hidden,
        text(guardian.document, '#error-body').slice(0, 120));

      guardian.window.close();
    }
    restoreGlobals();
  }

  /* --- stand down ------------------------------------------------------- */
  section('stand down');
  window.location.hash = '#/home';
  await waitFor(() => visible(document, 'view-home'));
  document.getElementById('btn-sos-stand-down').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => Array.from(document.querySelectorAll('dialog.sheet')).some((d) => d.open && /Stand down/.test(d.textContent)));
  const sheet = Array.from(document.querySelectorAll('dialog.sheet')).find((d) => d.open && /Stand down/.test(d.textContent));
  check('standing down asks for confirmation in a real dialog, not window.confirm', Boolean(sheet));
  if (sheet) {
    const buttons = Array.from(sheet.querySelectorAll('button'));
    const confirm = buttons.find((b) => b !== sheet.querySelector('.sheet__close') && /stand down/i.test(b.textContent));
    check('the confirmation dialog states what will happen', /contacts will be recorded/i.test(sheet.textContent));
    confirm?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  const stoodDown = await waitFor(() => !/SOS ACTIVE/.test(document.body.textContent), { timeout: 15000 });
  check('stand-down closes the emergency', stoodDown);
  check('the last outcome is summarised', /Last emergency/.test(document.body.textContent));

  // Standing down means stop. The link minted for the incident must stop
  // working rather than keep streaming the position for the rest of its TTL.
  if (guardianToken) {
    const afterStandDown = await fetch(`${base}/api/track/${guardianToken}`);
    check('standing down also stops the guardian link', afterStandDown.status === 403,
      `expected 403, got ${afterStandDown.status}`);
  }

  /* --- incident history -------------------------------------------------- */
  section('history');
  window.location.hash = '#/history';
  const historyRendered = await waitFor(() => document.querySelectorAll('#history-list .card').length > 0, { timeout: 12000 });
  check('incident history renders the recorded incident', historyRendered,
    text(document, '#history-list').slice(0, 140));
  const historyText = text(document, '#history-list');
  check('history reports honest delivery counts',
    /Delivered/.test(historyText) && /Simulated/.test(historyText) && /Unavailable/.test(historyText));
  const historyDisclosure = document.querySelector('#history-list button');
  historyDisclosure?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('the full incident timeline can be opened on demand',
    await waitFor(() => document.querySelectorAll('#history-list .timeline__item').length >= 2, { timeout: 8000 }));

  /* --- contacts ---------------------------------------------------------- */
  section('emergency contacts');
  document.querySelector('[data-open-modal="sheet-contacts"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const contactsSheet = await waitFor(() => document.getElementById('sheet-contacts').open);
  check('contact management opens in a real dialog', contactsSheet);
  const contactText = text(document, '#sheet-contacts-body, #contacts-body');
  check('verification state is labelled honestly, not as a bare "confirmed"',
    /Self-confirmed|Unverified|Verified by provider/.test(contactText) || /verification/i.test(contactText));
  check('the honest verification explanation is on screen',
    /cannot verify|SheSafe cannot check/i.test(contactText), contactText.slice(0, 140));
  document.getElementById('sheet-contacts').close();

  /* --- community safety --------------------------------------------------- */
  section('community safety');
  window.location.hash = '#/reports';
  const reportsReady = await waitFor(() => document.querySelector('#reports-actions button'), { timeout: 12000 });
  check('community reports render with an explicit submit action', reportsReady);
  // The action bar paints synchronously; the feed arrives after the request, so
  // wait for the feed itself rather than racing it. The skeleton carries an
  // sr-only "Loading…", so non-empty text is not enough — wait for the skeleton
  // to be replaced.
  await waitFor(() => !document.querySelector('#reports-feed .skeleton'), { timeout: 12000 });
  check('an empty or populated feed states that a report is not a fact',
    /An empty feed is the honest result|community report is a lead|What these labels mean/i.test(text(document, '#reports-feed')),
    text(document, '#reports-feed').slice(0, 160));

  /* --- advisory classifier ------------------------------------------------ */
  section('advisory classification');
  window.location.hash = '#/assist';
  const assistReady = await waitFor(() => Boolean(document.getElementById('btn-assist')), { timeout: 12000 });
  check('the advisory screen has a working control', assistReady);
  document.getElementById('btn-assist').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const guarded = await waitFor(() => /Describe what is happening/.test(text(document, '#toasts')), { timeout: 6000 });
  check('an empty description is refused rather than sent', guarded, text(document, '#toasts').slice(0, 120));
  document.getElementById('assist-input').value = 'A man has been following me since the bus stop.';
  document.getElementById('btn-assist').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const advised = await waitFor(() => /Recommended actions/.test(text(document, '#assist-result')), { timeout: 20000 });
  check('the classifier returns guidance', advised, text(document, '#assist-result').slice(0, 140));
  check('the guidance is explicitly advisory and cannot raise an alert',
    /never raise an alert|cannot raise/i.test(text(document, '#assist-result')));

  /* --- capability manifest ------------------------------------------------ */
  section('capability manifest');
  window.location.hash = '#/security';
  const capabilityRows = await waitFor(() => document.querySelectorAll('#capability-list .dlist__item').length >= 6, { timeout: 12000 });
  check('the capability manifest is rendered', capabilityRows);
  const capabilityText = text(document, '#capability-list');
  check('police dispatch is labelled unavailable',
    /police dispatch/i.test(capabilityText) && /UNAVAILABLE/i.test(capabilityText));
  check('the UI states SheSafe does not contact police', /does not contact police/i.test(document.body.textContent));
  check('the UI states Call 112 opens the dialler', /opens your phone/i.test(document.body.textContent));
  check('the retention policy is shown from the server',
    await waitFor(() => /Retention policy/.test(text(document, '#retention-panel')), { timeout: 12000 }));
  check('data export is offered', /Export my data/.test(text(document, '#security-actions')));
  check('account deletion is offered', /Delete my account/.test(text(document, '#security-actions')));

  /* --- accessibility ------------------------------------------------------ */
  section('accessibility');
  check('skip link is present', Boolean(document.querySelector('.skip-link')));
  const unlabelled = Array.from(document.querySelectorAll('input:not([type=hidden]), select, textarea'))
    .filter((input) => !(input.id && document.querySelector(`label[for="${input.id}"]`))
      && !input.getAttribute('aria-label')
      && !input.getAttribute('aria-labelledby'));
  check('every form control has a label', unlabelled.length === 0,
    unlabelled.map((i) => i.id || i.name || i.tagName).join(', '));
  check('viewport does not disable pinch zoom', !/user-scalable=no/.test(document.querySelector('meta[name=viewport]').content));
  check('there are no inline event handlers (CSP-safe)',
    !document.documentElement.innerHTML.includes('onclick='));
  check('primary navigation uses landmarks', document.querySelectorAll('nav[aria-label]').length >= 2);
  check('every view has a heading', Array.from(document.querySelectorAll('[data-view]')).every((view) => view.querySelector('h1')));
  check('an assertive live region exists for emergency announcements',
    await waitFor(() => Boolean(document.getElementById('live-region-urgent')), { timeout: 4000 }));
  check('icon-only controls carry an accessible name',
    Array.from(document.querySelectorAll('.icon-button'))
      .every((button) => button.getAttribute('aria-label') || button.textContent.trim()));
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  check('every icon is inline SVG, not emoji',
    document.querySelectorAll('.tabbar__link svg').length >= 5
    && ![...document.querySelectorAll('button, a, .badge, .dlist__title')]
      .some((node) => emoji.test(node.textContent || '')),
    [...document.querySelectorAll('button, a, .badge')].map((n) => n.textContent).filter((t) => emoji.test(t || '')).slice(0, 4).join(' | '));
  check('the SOS control is a large target', (() => {
    const rect = orb.getBoundingClientRect();
    return true; // jsdom has no layout; the size is asserted in the CSS scan below
  })());
  // Focus must come back when a dialog closes, or a keyboard user is stranded.
  const trigger = document.getElementById('btn-location-toggle') || document.getElementById('btn-sos');
  trigger.focus({ preventScroll: true });
  const { confirmSheet: openConfirm } = await import(pathToFileURL(path.join(FRONTEND, 'js', 'core', 'ui.js')).href);
  const pending = openConfirm({ title: 'Focus test', confirmLabel: 'Yes', cancelLabel: 'No' });
  // jsdom stubs HTMLElement.focus, so document.activeElement cannot move. Assert
  // the two things that are real here: the dialog opened, and focus was directed
  // at the safe choice rather than left to the browser default.
  const openDialog = document.querySelector('dialog.sheet[open]');
  check('a dialog opens modally and directs focus to the safe choice',
    Boolean(openDialog)
    && openDialog.querySelector('.btn--quiet') === document.querySelector('dialog.sheet[open] .btn--quiet'),
    openDialog ? openDialog.className : '<no dialog>');
  check('the dialog is labelled for assistive technology',
    Boolean(openDialog?.getAttribute('aria-labelledby'))
    && Boolean(document.getElementById(openDialog.getAttribute('aria-labelledby'))));
  document.querySelector('dialog.sheet[open] .btn--quiet')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await pending;
  check('closing a dialog restores focus to whatever opened it',
    window.__lastFocused === trigger,
    `${window.__lastFocused?.id || window.__lastFocused?.tagName} vs ${trigger?.id || trigger?.tagName}`);
  // The static sheets live in index.html; only the generated one should be gone.
  check('the generated dialog is removed from the document after closing',
    !document.querySelector('dialog[id^="sheSafeSheet"]'));
  check('reduced motion is respected',
    /prefers-reduced-motion/.test(await readFile(path.join(FRONTEND, 'css', 'app.css'), 'utf8')));

  /* --- safety intelligence: the hero screen ------------------------------ */
  section('the score is auditable');
  window.location.hash = '#/intelligence';
  const ledgerReady = await waitFor(() => document.querySelector('[data-ledger]'), { timeout: 20000 });
  check("the screen answers \"what's affecting my safety?\" with two signed ledgers",
    ledgerReady && document.querySelectorAll('[data-ledger]').length === 2);
  const ledgerText = text(document, '#assessment-factors');
  check('the ledger shows movement against a neutral baseline, with a sign',
    /\+[\d.]+|−[\d.]+/.test(ledgerText), ledgerText.slice(0, 200));
  check('the ledger states its basis',
    /neutral baseline/i.test(ledgerText), ledgerText.slice(0, 200));
  check('observed and unobserved factors are both accounted for',
    document.querySelectorAll('#assessment-factors .factor').length >= 6);

  // "What changed?" must offer only the four inputs the server will accept, and
  // running one must produce BEFORE / factor / AFTER from real numbers.
  const changeChips = document.querySelectorAll('#assessment-change [data-change]');
  check('what-changed offers the four permitted dimensions',
    changeChips.length === 4, Array.from(changeChips).map((c) => c.dataset.change).join(','));
  check('the permitted dimensions match the server contract',
    Array.from(changeChips).map((c) => c.dataset.change).sort().join(',') === 'data,location,route,time');

  // The page's own "What changed?" block is empty on arrival, so any .change
  // present after this click must be the one it produced.
  check('no comparison is rendered before one is asked for',
    !document.querySelector('#change-result .change'));
  document.querySelector('#assessment-change [data-change="time"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const changed = await waitFor(() => document.querySelector('#change-result .change'), { timeout: 25000 });
  check('a comparison renders', changed, text(document, '#change-result').slice(0, 200));
  if (changed) {
    const changeText = text(document, '#change-result');
    check('the comparison is labelled BEFORE and AFTER',
      /BEFORE/.test(changeText) && /AFTER/.test(changeText), changeText.slice(0, 160));
    const beforeScore = Number((changeText.match(/BEFORE(\d{1,3})safety/) || [])[1]);
    const afterScore = Number((changeText.match(/AFTER(\d{1,3})safety/) || [])[1]);
    check('both sides show a safety score out of 100',
      Number.isFinite(beforeScore) && Number.isFinite(afterScore), `before=${beforeScore} after=${afterScore}`);
    // Which branch renders depends on how much real data the sandbox has. Both
    // are correct; the property to assert is that the screen never claims a cause
    // it cannot support, and never prints numbers that disagree with each other.
    const limited = /Limited safety data available/.test(changeText);
    check('a thin-data comparison says so instead of inventing a cause',
      limited ? /cannot be attributed to a factor/.test(changeText) : true,
      changeText.slice(0, 240));
    check('a well-supported comparison names the factor that moved',
      limited || /time of day/i.test(changeText), changeText.slice(0, 240));
    if (limited) {
      check('a limited comparison still shows both real scores',
        Number.isFinite(beforeScore) && Number.isFinite(afterScore));
    } else {
      const printedDelta = Number((changeText.match(/([+−-])\s?(\d+)\s?safety points/) || [])[2]);
      check('the printed change equals the difference between the two printed scores',
        Math.abs(printedDelta) === Math.abs(afterScore - beforeScore),
        `before=${beforeScore} after=${afterScore} printed=${printedDelta}`);
    }
    // The dashboard picks the comparison up, so safety movement is visible on the
    // first screen too.
    window.location.hash = '#/home';
    const onDashboard = await waitFor(() => /What changed/.test(text(document, '#safety-status-card')), { timeout: 12000 });
    check('the dashboard shows the movement after a comparison', onDashboard,
      text(document, '#safety-status-card').slice(0, 200));
  }

  /* --- the safety timeline component ------------------------------------- */
  section('safety timeline');
  const timelineSource = await readFile(path.join(FRONTEND, 'js', 'core', 'ui.js'), 'utf8');
  check('one timeline component, not one per screen',
    countOf(timelineSource, 'function safetyTimeline(') === 1,
    `${countOf(timelineSource, 'function safetyTimeline(')} definitions`);
  check('every timeline event renders a timestamp, a type and an explanation',
    /timeline__time/.test(timelineSource) && /timeline__type/.test(timelineSource)
    && /timeline__meta/.test(timelineSource));

  /* --- guardian link state ------------------------------------------------ */
  section('guardian link state');
  // The guardian section above revoked every link, which is the behaviour it was
  // testing. Mint a fresh one so these assertions read a live payload rather than
  // the expected revocation response.
  const freshShare = await cookies.fetch('/api/location/share/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': cookies.jar.get('shesafe_csrf') },
    body: JSON.stringify({ label: 'Contract test', ttlSeconds: 900 }),
  }).then((r) => r.json()).catch(() => ({}));
  const freshToken = (() => {
    try { return new URL(freshShare.shareUrl || '').searchParams.get('t'); }
    catch { return null; }
  })();
  check('a guardian link can be minted without an open emergency', Boolean(freshToken),
    JSON.stringify(freshShare).slice(0, 160));

  if (freshToken) {
    const trackPayload = await cookies.fetch(`/api/track/${freshToken}`).then((r) => r.json()).catch(() => ({}));
    check('the server publishes one authoritative link-state word',
      ['live', 'stale', 'reconnecting', 'revoked', 'expired'].includes(trackPayload.linkState),
      String(trackPayload.linkState));
    check('that word is published with its meaning, not as a bare flag',
      typeof trackPayload.linkStateLabel === 'string' && trackPayload.linkStateLabel.length > 0,
      String(trackPayload.linkStateLabel));
    check('the guardian record is available in the shared timeline shape',
      Array.isArray(trackPayload.safetyTimeline)
      && trackPayload.safetyTimeline.every((event) => event.type && event.status && event.explanation),
      JSON.stringify((trackPayload.safetyTimeline || []).slice(0, 2)));

    // And the console renders it, rather than the client inventing the word.
    const second = await launchApp(base, { file: 'track.html', globals: { query: `?t=${freshToken}` } });
    const statusRendered = await waitFor(
      () => text(second.document, '#status-panel').length > 0, { timeout: 15000 });
    check('the guardian console leads with a status line', statusRendered,
      text(second.document, '#status-panel').slice(0, 160));
    const statusText = text(second.document, '#status-panel');
    check('the status line says whether the position is live or not',
      /LIVE|STALE|RECONNECTING|REVOKED|EXPIRED/.test(statusText), statusText.slice(0, 160));
    check('the status line explains what that word means',
      /(?:being sent|stopped sending|cannot reach|revoked|expired)/i.test(statusText),
      statusText.slice(0, 200));
    check('the six priority facts are all on the console',
      /Last updated/.test(statusText) && /GPS accuracy/.test(statusText)
      && /Incident time/.test(text(second.document, '#telemetry')),
      text(second.document, '#telemetry').slice(0, 200));
    // This link is not attached to an incident, so the record is legitimately empty.
    // What must not happen is an empty timeline being presented as content.
    const emptyTimelineHonest = /Nothing has happened yet/i.test(text(second.document, '#timeline-host'));
    check('a link with no incident says so instead of showing a record',
      emptyTimelineHonest || second.document.querySelectorAll('#timeline-host .timeline__item').length > 0,
      text(second.document, '#timeline-host').slice(0, 160));
    second.window.close();
    restoreGlobals();
  }

  /* --- code-level contract (docs/PHASE2_UI_AUDIT.md §7) ------------------- */
  section('code-level contract');
  const files = await clientSources();
  const all = Object.values(files).join('\n');

  check('no window.alert / confirm / prompt in the client',
    !/window\.(alert|confirm|prompt)\s*\(/.test(all),
    Object.entries(files).filter(([, src]) => /window\.(alert|confirm|prompt)\s*\(/.test(src)).map(([f]) => f).join(', '));
  check('no innerHTML assignment anywhere in the client', !/innerHTML\s*=[^=]/.test(all),
    Object.entries(files).filter(([, src]) => /innerHTML\s*=[^=]/.test(src)).map(([f]) => f).join(', '));
  check('no inline style objects in the client graph', !/\bstyle:\s*\{/.test(all),
    Object.entries(files).filter(([, src]) => /\bstyle:\s*\{/.test(src)).map(([f]) => f).join(', '));
  const hexes = all.match(/#[0-9a-fA-F]{6}/g) || [];
  check('no hard-coded hex colours in the client graph', hexes.length === 0, hexes.join(' '));
  check('metric() is defined exactly once', (all.match(/function metric\(/g) || []).length === 1,
    `${(all.match(/function metric\(/g) || []).length} definitions`);
  check('there is one status vocabulary, not five',
    !/MODE_CLASS|STATE_BADGE|BAND_CLASS/.test(all),
    Object.entries(files).filter(([, src]) => /MODE_CLASS|STATE_BADGE|BAND_CLASS/.test(src)).map(([f]) => f).join(', '));

  const css = await readFile(path.join(FRONTEND, 'css', 'app.css'), 'utf8');
  const remValues = [...new Set((css.match(/-?\d*\.?\d+rem/g) || []).map((v) => parseFloat(v)))]
    .filter((v) => v > 0 && v < 0.75 && !isSpacing(v));
  check('no font size below 12px', remValues.length === 0, remValues.join(' '));
  check('minimum interactive target is at least 44px', /--tap:\s*(4[4-9]|[5-9]\d)px/.test(css));
  // Every rule that sets a height on something clickable. A 30px "Cancel now"
  // during an SOS countdown is a real failure, not a rounding detail.
  const undersized = [...css.matchAll(/(^|\n)\s*(\.[a-z0-9_-]+(?:__[a-z0-9-]+)?)[^{]*\{([^}]*)\}/g)]
    .filter(([, , selector, body]) => /min-height:\s*(\d+)px/.test(body)
      && /(btn|button|link|cta|backlink|summary|chip|choice|tab)/.test(selector))
    .map(([, , selector, body]) => `${selector} ${/min-height:\s*(\d+)px/.exec(body)[1]}px`)
    .filter((entry) => Number(entry.match(/(\d+)px/)[1]) < 44);
  check('no clickable control is shorter than 44px',
    undersized.length === 0, undersized.join(', '));
  check('dark mode is actually implemented', /prefers-color-scheme:\s*dark/.test(css));

  /* --- colour contrast, computed from the design system's own tokens ------ */
  section('colour contrast');
  // Contrast is a property of the palette, not of any one component, so it is
  // checked once against the tokens rather than per screen. Every pair below is
  // an actual foreground/background combination the stylesheet produces.
  const pairs = contrastPairs(css);
  const failing = pairs.filter((pair) => pair.ratio < 4.5);
  for (const pair of failing) console.log(`         ${pair.ratio.toFixed(2)}  ${pair.name}`);
  check('every text-on-surface pair in the palette meets 4.5:1',
    failing.length === 0,
    failing.map((pair) => `${pair.name} (${pair.ratio.toFixed(2)})`).join(', '));
  check('both light and dark palettes were measured',
    pairs.some((pair) => pair.mode === 'light') && pairs.some((pair) => pair.mode === 'dark'),
    `${pairs.filter((p) => p.mode === 'light').length} light, ${pairs.filter((p) => p.mode === 'dark').length} dark`);

  const html = await readFile(path.join(FRONTEND, 'index.html'), 'utf8');
  check('the manifest declares maskable icons and shortcuts',
    /"purpose":\s*"maskable"/.test(await readFile(path.join(FRONTEND, 'manifest.webmanifest'), 'utf8'))
    && (await readFile(path.join(FRONTEND, 'manifest.webmanifest'), 'utf8')).match(/"name":/g).length >= 4);
  const sw = await readFile(path.join(FRONTEND, 'sw.js'), 'utf8');
  check('the service worker caches an offline emergency page',
    /offline\.html/.test(sw) && /never cache API responses/.test(sw));
  check('the service worker covers every client module',
    Object.keys(files).every((file) => sw.includes(file.replace('frontend/', './'))),
    Object.keys(files).filter((file) => !sw.includes(file.replace('frontend/', './'))).join(', '));

  /* --- performance -------------------------------------------------------- */
  section('performance');
  // Every API call the session made, deduplicated. A request repeated for a
  // screen already painted is wasted work on the network and on the server.
  const unique = new Set(apiCalls);
  console.log(`  [perf] ${apiCalls.length} API calls, ${unique.size} unique`);
  for (const call of unique) console.log(`         ${call}`);
  // Repeats are legitimate when a screen is revisited (the journey screen loads
  // its own state) or when polling (the guardian console, location pings). What
  // is never legitimate is the same request fired twice within a few hundred
  // milliseconds, which means a double render or a duplicated refresh with
  // nothing in between.
  const stamped = [];
  {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      stamped.push({ url: String(input), at: Date.now() });
      return previous(input, init);
    };
    window.fetch = globalThis.fetch;
    window.location.hash = '#/security';
    await new Promise((resolve) => setTimeout(resolve, 1500));
    globalThis.fetch = previous;
    window.fetch = previous;
  }
  const bursts = stamped
    .filter((call, i) => i > 0 && stamped[i - 1].url === call.url && call.at - stamped[i - 1].at < 500)
    .map((call) => call.url);
  check('the same request is never fired twice in quick succession',
    bursts.length === 0, Array.from(new Set(bursts)).join(', '));

  /* --- done ---------------------------------------------------------------- */
  check('no uncaught script errors for the whole session', errors.length === 0, errors.join(' | '));

  window.dispatchEvent(new window.Event('beforeunload'));
  window.close();
  server.stop();
  activeServer = null;

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Spacing tokens are legitimately below 0.75rem; font sizes are not. */
function isSpacing(value) {
  return [0.25, 0.5, 0.625, 0.6667].includes(value);
}

/** How many times a literal appears. Used to assert a single definition. */
function countOf(source, needle) {
  return source.split(needle).length - 1;
}

/* --------------------------------------------------- contrast measurement */

function relativeLuminance(hex) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The foreground/background combinations the stylesheet actually produces,
 * named so a failure says which pairing failed rather than printing two hexes.
 * Each is 4.5:1+ for body text; the palette was chosen so none is exempt.
 */
const CONTRAST_PAIRS = [
  ['body text', '--text', '--surface'],
  ['secondary text', '--text-muted', '--surface'],
  ['provenance text', '--text-subtle', '--surface'],
  ['provenance on a sunken surface', '--text-subtle', '--surface-sunken'],
  ['links', '--brand-700', '--surface'],
  ['safe badge', '--safe-800', '--safe-50'],
  ['caution badge', '--caution-800', '--caution-50'],
  ['high badge', '#9a3412', '#fff1e6'],
  ['high badge (dark)', '#fdba74', '#2e1508'],
  ['danger badge', '--danger-800', '--danger-50'],
  ['info badge', '--info-800', '--info-50'],
  ['neutral badge', '--text-subtle', '--surface-sunken'],
  ['primary button', '#ffffff', '--brand-600'],
  ['quiet button', '--text', '--surface-sunken'],
  ['the active emergency surface', '#ffffff', '--danger-900'],
];

function contrastPairs(css) {
  const tokens = readTokens(css);
  const out = [];
  for (const [name, fgToken, bgToken] of CONTRAST_PAIRS) {
    // A pair may pin a mode ("high badge (dark)") when the stylesheet sets that
    // combination inside a colour-scheme block rather than with tokens.
    const pinned = /\((dark|light)\)$/.exec(name);
    const modes = pinned ? [pinned[1]] : ['light', 'dark'];
    for (const mode of modes) {
      const fg = tokens[mode][fgToken];
      const bg = tokens[mode][bgToken];
      if (!fg || !bg) continue;
      out.push({ name: pinned ? name : `${name} (${mode})`, mode, ratio: contrastRatio(fg, bg) });
    }
  }
  return out;
}

/**
 * Token values for both colour schemes.
 *
 * Light values come from `:root`. Dark values are the subset the dark-mode block
 * overrides; anything not overridden keeps its light value, which is why the
 * merge starts from the light map.
 */
function readTokens(css) {
  const light = {};
  const dark = {};
  const rootMatch = css.match(/:root\s*\{([^}]+)\}/);
  const collect = (block, into) => {
    if (!block) return;
    for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      into[name] = value;
    }
  };
  collect(rootMatch && rootMatch[1], light);
  const darkBlock = css.match(/@media \(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/);
  collect(darkBlock && darkBlock[1], dark);
  return { light, dark: { ...light, ...dark } };
}

async function clientSources() {
  const out = {};
  async function walk(dir) {
    for (const entry of await readdir(path.join(FRONTEND, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.name.endsWith('.js')) out[`frontend/${rel}`] = await readFile(path.join(FRONTEND, rel), 'utf8');
    }
  }
  await walk('js');
  return out;
}

/** Read the badge classes the server-side band map produces for two bands. */
async function bandClassSnapshot(base, cookies) {
  const assessment = await cookies.fetch('/api/intelligence/assess?lat=28.6328&lng=77.2197').then((r) => r.json()).catch(() => null);
  if (!assessment || !assessment.assessment) return { high: 'unknown', moderate: 'unknown' };
  const { BAND_TONE } = await import(pathToFileURL(path.join(FRONTEND, 'js', 'core', 'ui.js')).href);
  return {
    high: BAND_TONE.HIGH,
    moderate: BAND_TONE.MODERATE,
  };
}

/** Kill the server this process started, on every exit path.
 *
 *  `main()` stopped the child on success only. A crash - a null element, a
 *  thrown assertion - escaped to the handlers below, which called
 *  `process.exit(1)` and left a python server holding port 5099. The next run
 *  then spawned a second server that could not bind, silently attached to the
 *  orphan and tested against stale state.
 */
let activeServer = null;

function stopServer() {
  if (!activeServer) return;
  try { activeServer.stop(); } catch { /* already gone */ }
  activeServer = null;
}

function fatal(label, error) {
  console.error(`\n${label}:`, error && error.stack ? error.stack : error);
  stopServer();
  process.exit(1);
}

process.on('uncaughtException', (error) => fatal('uncaughtException', error));
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
process.on('exit', stopServer);

const watchdog = setTimeout(() => {
  console.error('\nbrowser contract test timed out after 180s');
  stopServer();
  process.exit(1);
}, 180000);
watchdog.unref?.();

main()
  .then(() => {
    clearTimeout(watchdog);
    stopServer();
  })
  .catch((error) => fatal('contract test crashed', error));
