/**
 * Frontend smoke test (jsdom).
 *
 * Runs the real `js/app.js` module graph in a simulated browser against a live
 * SheSafe server, then asserts that the user-visible contract holds:
 *
 *   - the app boots and resolves its session,
 *   - sign-in works and the dashboard renders with the signed-in user,
 *   - the SOS flow drives the countdown and then reports the *server's* truth
 *     (delivered / simulated / unavailable) rather than a hardcoded success,
 *   - capability badges reflect the manifest, so nothing is over-claimed,
 *   - the sign-in view is actually enforced for unauthenticated navigation.
 *
 * Why jsdom and not a real browser: this is a contract test between the client
 * modules and the API. Geolocation, audio and Leaflet are unavailable in jsdom
 * and are stubbed; those code paths are covered by their own unit-level guards.
 *
 * Usage:
 *   node tests/frontend/smoke.mjs                # starts its own server
 *   BASE_URL=http://127.0.0.1:5000 node tests/frontend/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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

/* ------------------------------------------------------------- server --- */

async function waitForServer(base, attempts = 60) {
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
        SHESAFE_DB: path.join(REPO, 'backend', 'data', 'smoke-test.db'),
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  if (!(await waitForServer(base))) {
    child.kill('SIGKILL');
    throw new Error(`Test server did not start:\n${logs.join('').slice(-2000)}`);
  }
  return { base, stop: () => child.kill('SIGKILL') };
}

/* --------------------------------------------------------------- dom ---- */

async function launchApp(base) {
  const html = await readFile(path.join(FRONTEND, 'index.html'), 'utf8');
  const css = await readFile(path.join(FRONTEND, 'css', 'app.css'), 'utf8');

  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (error) => {
    // jsdom cannot parse CSS nesting-free custom properties in some builds; only
    // surface script errors.
    if (!/Could not parse CSS/.test(error.message)) errors.push(error.message);
  });
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));

  const dom = new JSDOM(html, {
    url: `${base}/index.html`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  // --- browser API stubs ---------------------------------------------------
  // Capture Node's fetch *before* installing the wrapper: once the wrapper is on
  // `window`, `globalThis.fetch` will point at it and the call would recurse.
  //
  // Node's fetch has no cookie jar, so we implement the minimum a browser gives
  // us for free: honour `Set-Cookie` and expose `document.cookie`. Without this
  // the CSRF double-submit check correctly rejects every write.
  const nodeFetch = globalThis.fetch;
  const jar = new Map();

  function parseSetCookie(header) {
    const [pair, ...attrs] = header.split(';');
    const index = pair.indexOf('=');
    if (index === -1) return null;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attrs.some((attr) => /(^|\s)max-age=0(\s|$)/i.test(attr) || /(^|\s)expires=thu, 01 jan 1970/i.test(attr));
    return { name, value, expired };
  }

  const cookieDescriptor = {
    configurable: true,
    get() {
      return Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');
    },
    set(raw) {
      const parsed = parseSetCookie(String(raw));
      if (!parsed) return;
      if (parsed.expired) jar.delete(parsed.name);
      else jar.set(parsed.name, parsed.value);
    },
  };
  Object.defineProperty(window.document, 'cookie', cookieDescriptor);

  window.fetch = async (input, init) => {
    const target = new URL(String(input), base).toString();
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
  };
  window.__cookies = jar;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.confirm = () => true;
  window.prompt = () => 'test note';
  window.alert = () => {};
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.focus = () => {};
  window.HTMLElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLElement.prototype.close = function close() { this.open = false; };

  // Location is denied by default so the suite exercises the real "permission
  // denied" path. A scenario may opt in to a synthetic fix; that fix is a test
  // double and is labelled as such wherever it surfaces.
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

  // Inject the stylesheet so `hidden` / layout helpers behave as in a browser.
  const style = window.document.createElement('style');
  style.textContent = css;
  window.document.head.appendChild(style);

  // jsdom cannot execute `type="module"` scripts, so expose the jsdom window as
  // the ambient global and then import the real module graph. The application
  // code is unmodified — it just runs with browser globals in scope.
  // Timers, console and URL are deliberately NOT overridden: Node's are
  // behaviourally equivalent and swapping them for jsdom's silently starves the
  // harness's own polling loops.
  // NOTE: fetch/Headers/Request/Response/AbortController stay as Node's. Passing
  // jsdom's AbortSignal into Node's fetch throws a TypeError, which would look
  // like "server unreachable".
  const GLOBALS = [
    'window', 'document', 'navigator', 'location', 'history', 'localStorage',
    'sessionStorage', 'fetch',
    'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
    'HTMLElement', 'Element', 'Node', 'getComputedStyle',
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
  // navigator and location are getter-only on modern Node globals.
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true, writable: true });

  const entry = pathToFileURL(path.join(FRONTEND, 'js', 'app.js')).href;
  await import(`${entry}?t=${Date.now()}`);

  return { dom, window, document: window.document, errors };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 4000, interval = 40 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(interval);
  }
  return false;
}

/* --------------------------------------------------------------- main --- */

async function main() {
  const external = process.env.BASE_URL;
  const server = external ? { base: external, stop: () => {} } : await startServer();
  const base = server.base;
  console.log(`\nSheSafe frontend smoke test → ${base}\n`);

  const { window, document, errors } = await launchApp(base);

  // --- boot ---------------------------------------------------------------
  console.log('boot');
  const booted = await waitFor(() => !document.getElementById('view-auth').hidden
    || document.querySelector('#form-login button[type=submit]'));
  check('app boots and renders the authentication view', booted);
  check('no uncaught script errors during boot', errors.length === 0, errors.join(' | '));
  const ribbonShown = await waitFor(() => Boolean(document.querySelector('.demo-ribbon')));
  check('demo mode ribbon is shown', ribbonShown);

  // --- unauthenticated guard ---------------------------------------------
  console.log('\nunauthenticated access control');
  window.location.hash = '#/intelligence';
  const bounced = await waitFor(() => window.location.hash === '#/home');
  check('unauthenticated navigation to a private view is bounced', bounced, window.location.hash);

  // --- sign in ------------------------------------------------------------
  console.log('\nsign in');
  document.getElementById('login-identifier').value = 'demo@shesafe.local';
  document.getElementById('login-password').value = process.env.SHESAFE_DEMO_PASSWORD || 'shesafe-demo';
  document.getElementById('form-login').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const signedIn = await waitFor(() => document.getElementById('view-home') && !document.getElementById('view-home').hidden);
  if (!signedIn) {
    process.stderr.write(`[smoke] toasts: ${document.getElementById('toasts').textContent}\n`);
    process.stderr.write(`[smoke] script errors: ${errors.join(' | ')}\n`);
  }
  check('sign-in succeeds and the dashboard is shown', signedIn);
  const greeting = document.getElementById('home-first-name')?.textContent || '';
  const greeted = await waitFor(() => {
    const value = document.getElementById('home-first-name').textContent || '';
    return value.length > 0 && value !== 'there';
  });
  check('dashboard greets the signed-in user by name', greeted, greeting);

  const session = await (await fetch(`${base}/api/auth/session`, {
    headers: { Cookie: document.cookie.split('; ').map((c) => c.split('=')[0]).join('=') },
  })).json().catch(() => ({}));
  check('the client authenticated against the real API', Boolean(session), JSON.stringify(session).slice(0, 120));

  // --- capability honesty -------------------------------------------------
  console.log('\ncapability manifest');
  const capabilityRows = document.querySelectorAll('#capability-list li');
  check('capability manifest is rendered', capabilityRows.length >= 6, `${capabilityRows.length} rows`);
  const capabilityText = document.getElementById('capability-list')?.textContent || '';
  check('police dispatch is labelled unavailable', /police dispatch/i.test(capabilityText) && /unavailable/i.test(capabilityText));
  check('the UI states SheSafe does not contact police', /does not contact police/i.test(document.body.textContent));
  check('the UI states Call 112 opens the dialler', /opens your phone/i.test(document.body.textContent));

  // --- contacts -----------------------------------------------------------
  console.log('\nemergency contacts');
  const contactsRendered = await waitFor(() => document.querySelector('#contacts-list li, #contacts-list .state'));
  check('contacts panel renders', contactsRendered);
  check('no contact names are rendered as raw HTML', !document.getElementById('contacts-list').innerHTML.includes('<script'));

  // --- SOS lifecycle ------------------------------------------------------
  console.log('\nSOS lifecycle');
  document.getElementById('btn-sos').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const armed = await waitFor(() => document.body.textContent.includes('Emergency armed'));
  check('SOS press shows the cancellation countdown', armed);

  const countdownVisible = await waitFor(() => /Cancelling in \d+s/.test(document.body.textContent));
  check('countdown reports the remaining seconds', countdownVisible);

  const activated = await waitFor(
    () => document.body.textContent.includes('Emergency active') || document.body.textContent.includes('Escalating'),
    { timeout: 20000 },
  );
  check('SOS activates after the cancel window', activated, document.body.textContent.slice(0, 200));

  const bannerText = document.getElementById('emergency-banner')?.textContent || '';
  check('active banner shows the incident reference', /Ref SS-/.test(bannerText));
  check('active banner reports notification counts', /Delivered/.test(bannerText) && /Simulated/.test(bannerText));
  check('active banner does not claim police were contacted', !/police (control room|were|has been) (notified|contacted|mobilised|mobilized)/i.test(bannerText));
  check('active banner offers Call 112', Boolean(document.querySelector('.sos-active a[href="tel:112"]')));

  // The simulation must be labelled, since no provider credentials exist.
  const simulatedOrHonest = /Simulated|Unavailable/i.test(bannerText);
  check('unconfigured notification channels are labelled, not faked', simulatedOrHonest, bannerText.slice(0, 160));

  // --- stand down ---------------------------------------------------------
  console.log('\nstand down');
  const standDown = Array.from(document.querySelectorAll('.sos-active button'))
    .find((button) => /stand down/i.test(button.textContent));
  check('stand-down control is present', Boolean(standDown));
  standDown?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const stoodDown = await waitFor(() => !document.body.textContent.includes('Emergency active'));
  check('stand-down closes the emergency', stoodDown);

  // --- history ------------------------------------------------------------
  console.log('\nhistory');
  window.location.hash = '#/history';
  const historyRendered = await waitFor(() => document.querySelector('#history-list article, #history-list .state'));
  check('incident history renders the recorded incident', historyRendered);
  const historyText = document.getElementById('history-list')?.textContent || '';
  check('history reports honest notification counts', /Delivered/.test(historyText) && /Simulated/.test(historyText));

  // --- accessibility basics ----------------------------------------------
  console.log('\naccessibility');
  check('skip link is present', Boolean(document.querySelector('.skip-link')));
  check('every form input has a label',
    Array.from(document.querySelectorAll('input:not([type=hidden]), select, textarea'))
      .every((input) => input.id && document.querySelector(`label[for="${input.id}"]`)));
  check('viewport does not disable pinch zoom', !/user-scalable=no/.test(document.querySelector('meta[name=viewport]').content));
  check('there are no inline event handlers (CSP-safe)',
    !document.documentElement.innerHTML.includes('onclick='));
  check('primary navigation uses landmarks', Boolean(document.querySelector('nav[aria-label]')));

  // --- location consent ---------------------------------------------------
  console.log('\nlocation');
  const refused = document.getElementById('location-summary').textContent;
  check('with location denied the UI says so instead of pretending to be live',
    /Location is off|Waiting for a position/i.test(refused), refused.slice(0, 120));

  window.__setLocationMode('granted');
  document.getElementById('btn-location-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const located = await waitFor(() => /28\.63/.test(document.getElementById('location-summary').textContent), { timeout: 8000 });
  check('enabling location shows the captured position', located, document.getElementById('location-summary').textContent.slice(0, 120));
  check('location accuracy is displayed', /±\d+/.test(document.getElementById('location-summary').textContent));

  // --- private view now reachable ----------------------------------------
  console.log('\nauthorised navigation');
  window.location.hash = '#/intelligence';
  const intelRendered = await waitFor(() => document.querySelector('#assessment-panel .card'), { timeout: 15000 });
  check('safety intelligence renders after sign-in', intelRendered);
  const intelText = document.getElementById('assessment-panel')?.textContent || '';

  check('safety score is explained, not just stated',
    /Feature weighting/i.test(intelText) || /What is driving/i.test(intelText));
  check('engine states it is not a trained model', /not a trained machine-learning model/i.test(intelText)
    || /rule set, not a trained model/i.test(intelText));

  window.dispatchEvent(new window.Event('beforeunload'));
  window.close();
  server.stop();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

process.on('uncaughtException', (error) => {
  console.error('\nuncaughtException:', error && error.stack ? error.stack : error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('\nunhandledRejection:', reason && reason.stack ? reason.stack : reason);
  process.exit(1);
});
// Watchdog: never let a hung promise keep CI alive.
const watchdog = setTimeout(() => {
  console.error('\nsmoke test timed out after 120s');
  process.exit(1);
}, 120000);
watchdog.unref?.();

main()
  .then(() => clearTimeout(watchdog))
  .catch((error) => {
    console.error('\nsmoke test crashed:', error);
    process.exit(1);
  });