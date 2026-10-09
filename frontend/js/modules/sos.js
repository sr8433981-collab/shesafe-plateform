/**
 * SOS emergency engine (client side).
 *
 * The browser's job is narrow and reliable:
 *   1. offer a short cancel window,
 *   2. obtain the best position it can,
 *   3. call the server once,
 *   4. show exactly what the server reported.
 *
 * It never decides whether an alert "succeeded". Copy is generated from the
 * server's `notificationSummary`, so if the message was simulated the user reads
 * SIMULATED. Voice activation routes through here too, and still requires the
 * same confirmation step — see voice.js.
 *
 * ## Activation
 *
 * The primary control is **press and hold** for 1.2 seconds. A pocket, a bag or a
 * frightened hand resting on the screen should not be able to alert anybody.
 * Two deliberate alternatives are provided and both are genuinely reachable:
 *
 *   * **Keyboard / assistive activation.** A synthesised click (`detail === 0`),
 *     which is what Enter, Space and a screen-reader activation produce, arms
 *     immediately.
 *   * **A labelled quick-arm control** next to the orb, for anyone who needs one
 *     tap and cannot hold.
 *
 * Both paths run the identical countdown, so neither can bypass the cancel
 * window or activate without confirmation.
 */

import { api, ApiError } from '../core/api.js';
import { announceUrgent } from '../core/dom.js';
import { locationManager } from '../core/location.js';
import { siren, toast } from '../core/feedback.js';
import { store } from '../core/store.js';

/** How long the SOS control must be held before it arms. */
export const HOLD_MS = 1200;

let countdownTimer = null;
let armedIncident = null;
let holdFrame = null;
let holdStart = 0;

/* ------------------------------------------------------------------ setup */

export function initSos({ onChange }) {
  store.on(['sosPhase', 'cancelSecondsLeft', 'incident', 'sirenOn'], onChange);
  void restore();
}

async function restore() {
  try {
    const { incident } = await api.activeIncident();
    if (incident && ['ACTIVE', 'ESCALATING'].includes(incident.state)) {
      store.set({ incident, sosPhase: incident.state, lastOutcome: incident.outcome || null });
      if (!siren.muted) siren.start();
    } else if (incident && ['RESOLVED', 'CANCELLED'].includes(incident.state)) {
      store.set({ incident, sosPhase: 'IDLE', lastOutcome: incident.outcome || incident.state });
    }
  } catch {
    /* boot-time check is best-effort; the server-down banner covers outages */
  }
}

export function isEmergencyOpen() {
  return ['ARMING', 'COUNTDOWN', 'ACTIVATING', 'ACTIVE', 'ESCALATING'].includes(store.get().sosPhase);
}

/* ------------------------------------------------------- press and hold */

/**
 * Wire press-and-hold activation onto a control.
 * @param {HTMLElement} node the `.sos-orb`
 */
export function mountTrigger(node) {
  if (!node || node.dataset.sosBound === 'true') return;
  node.dataset.sosBound = 'true';

  const begin = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    holdStart = Date.now();
    node.dataset.holding = 'true';
    tickHold();
  };

  const end = () => {
    node.dataset.holding = 'false';
    node.style.removeProperty('--hold');
    if (holdFrame) { window.cancelAnimationFrame(holdFrame); holdFrame = null; }
  };

  const tickHold = () => {
    const progress = Math.min(100, Math.round(((Date.now() - holdStart) / HOLD_MS) * 100));
    node.style.setProperty('--hold', String(progress));
    if (progress >= 100) {
      end();
      void arm('button');
      return;
    }
    holdFrame = window.requestAnimationFrame(tickHold);
  };

  node.addEventListener('pointerdown', begin);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('pointerleave', end);
  node.addEventListener('contextmenu', (event) => event.preventDefault());

  // `detail === 0` means the click was synthesised (keyboard, assistive tech,
  // or a programmatic activation) rather than produced by a pointer, so it is
  // a deliberate act and arms immediately.
  node.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    event.preventDefault();
    if (isEmergencyOpen()) return;
    void arm('button');
  });
}

/* --------------------------------------------------------------- lifecycle */

/** Step 1. Arm server-side and open the cancel window. */
export async function arm(triggerSource = 'button') {
  if (isEmergencyOpen()) return null;
  store.set({ sosPhase: 'ARMING' });
  announceUrgent('Emergency request started.');
  try {
    const response = await api.armSos(triggerSource);
    armedIncident = response.incident;
    const window_ = Number(response.cancelWindowSeconds) || 10;
    store.set({
      incident: response.incident,
      cancelSecondsLeft: window_,
      sosPhase: 'COUNTDOWN',
    });
    startCancelCountdown();
    announceUrgent(
      `Emergency armed. Reference ${response.incident.reference}. ` +
      `The alert activates in ${window_} seconds. Say cancel to stop it.`,
    );
    return response.incident;
  } catch (error) {
    store.set({ sosPhase: 'IDLE', cancelSecondsLeft: 0 });
    if (error instanceof ApiError && error.code === 'duplicate_suppressed') {
      try {
        const active = await api.activeIncident();
        store.set({ incident: active.incident, sosPhase: active.incident?.state || 'ACTIVE' });
        announceUrgent('An emergency is already open for this account.');
      } catch { /* keep the warning visible */ }
      toast('An emergency is already open. Use Stand down on the emergency screen.', 'warning', { timeout: 9000 });
      return null;
    }
    const message = error.message || 'Could not start the emergency. Check your connection.';
    toast(`${message} If this is an emergency, call 112.`, 'error', { timeout: 12000 });
    announceUrgent('The emergency could not be started. Call 112 now.');
    return null;
  }
}

function startCancelCountdown() {
  stopCountdown();
  countdownTimer = window.setInterval(() => {
    const left = store.get().cancelSecondsLeft - 1;
    if (left <= 0) {
      store.set({ cancelSecondsLeft: 0 });
      stopCountdown();
      void activate();
      return;
    }
    store.set({ cancelSecondsLeft: left });
    announceUrgent(`Emergency activates in ${left} seconds.`);
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/** Step 2. Cancel before any contact is alerted. Always available, one tap. */
export async function cancelBeforeActivation() {
  stopCountdown();
  if (!armedIncident) {
    store.set({ sosPhase: 'IDLE', cancelSecondsLeft: 0 });
    return;
  }
  try {
    const response = await api.cancelSos('Cancelled within the countdown window');
    store.set({ incident: response.incident, sosPhase: 'IDLE', cancelSecondsLeft: 0, lastOutcome: response.incident?.outcome || 'CANCELLED' });
    armedIncident = null;
    toast('Emergency cancelled. No contact was alerted.', 'info');
    announceUrgent('Emergency cancelled. Nobody was alerted.');
  } catch (error) {
    toast(error.message || 'Could not cancel the emergency.', 'error');
  }
}

/** Step 3. Acquire a position, activate, then report what the server said. */
export async function activate() {
  stopCountdown();
  const previousPhase = store.get().sosPhase;
  // ACTIVATING, not ACTIVE: the incident does not exist until the server has
  // written it. Saying "SOS ACTIVE" before the POST returns would be the same
  // class of lie as claiming a dispatch that never happened.
  store.set({ sosPhase: 'ACTIVATING' });

  // Position first: a late fix is still useful, but the alert must not wait on
  // one. Eight seconds is the ceiling, and a missing fix degrades honestly.
  const position = await locationManager.fix({ timeout: 8000 });
  const payload = position ? locationManager.currentPayload() : {};

  try {
    const response = await api.activateSos(payload);
    store.set({
      incident: response.incident,
      sosPhase: response.incident.state,
      cancelSecondsLeft: 0,
    });
    armedIncident = null;
    // The incident mints an incident-scoped tracking link. The raw token is
    // returned exactly once, by the call that created it, so it is kept for this
    // tab only — that is what makes "send this to my contacts" possible without
    // pretending SheSafe sent anything.
    if (response.share?.url) window.sessionStorage.setItem('shesafe:lastShareUrl', response.share.url);
    siren.start();
    siren.vibrate();
    store.set({ sirenOn: !siren.muted });
    announceUrgent(
      `SOS active. Incident ${response.incident.reference}. ` +
      'Call 112 now. SheSafe has not contacted police.',
    );
    reportNotifications(response);
    return response;
  } catch (error) {
    // Fall back to the previous phase so the UI never claims to be active.
    store.set({ sosPhase: previousPhase === 'COUNTDOWN' ? 'COUNTDOWN' : 'IDLE' });
    if (error instanceof ApiError && error.code === 'no_open_incident') {
      store.set({ sosPhase: 'IDLE', incident: null });
      toast('The emergency expired before it could be sent. Press SOS again.', 'error');
    } else {
      toast(error.message || 'Could not send the emergency alert. Press SOS again or call 112.', 'error', { timeout: 12000 });
      announceUrgent('The emergency alert could not be sent. Call 112 now.');
    }
    return null;
  }
}

function reportNotifications(response) {
  const summary = response.notificationSummary;
  if (!summary) return;
  if (summary.unavailable > 0 || summary.failed > 0) {
    const parts = [];
    if (summary.delivered) parts.push(`${summary.delivered} delivered`);
    if (summary.simulated) parts.push(`${summary.simulated} simulated`);
    if (summary.unavailable) parts.push(`${summary.unavailable} channel unavailable`);
    if (summary.failed) parts.push(`${summary.failed} failed`);
    toast(`Alert recorded: ${parts.join(', ')}. Call 112 if you need police.`, 'warning', { timeout: 10000 });
  }
}

/** Stand down after contacts were alerted. */
export async function resolve(note) {
  try {
    const response = await api.resolveSos(note || 'User confirmed they are safe.');
    // Keep the incident only long enough for the closing summary to render, then
    // clear it so nothing downstream keeps treating it as an open emergency.
    store.set({ incident: response.incident, sosPhase: 'IDLE', sirenOn: false, lastOutcome: 'RESOLVED_SAFE' });
    window.setTimeout(clearIncident, 8000);
    siren.stop();
    announceUrgent('Emergency stood down. Your contacts were recorded as told you are safe.');
    return response;
  } catch (error) {
    toast(error.message || 'Could not stand the emergency down.', 'error');
    return null;
  }
}

export async function escalate() {
  try {
    const response = await api.escalateSos();
    store.set({ incident: response.incident, sosPhase: 'ESCALATING' });
    announceUrgent('The incident is marked as escalating.');
    return response;
  } catch (error) {
    toast(error.message || 'Could not escalate.', 'error');
    return null;
  }
}

export function toggleSound() {
  const muted = siren.toggle();
  if (muted) siren.stop();
  else if (isEmergencyOpen()) siren.start();
  store.set({ sirenOn: !muted });
  return !muted;
}

/**
 * Drop the closed incident from memory.
 *
 * The durable record lives on the server; this only stops the shell from
 * continuing to present a resolved emergency as if it were still open.
 */
export function clearIncident() {
  store.set({ incident: null, sosPhase: 'IDLE', cancelSecondsLeft: 0, sirenOn: false });
  siren.stop();
}
