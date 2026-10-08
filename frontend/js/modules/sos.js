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
 * SIMULATED. Voice activation routes through here too, but still requires an
 * explicit confirmation step - see voice.js.
 */

import { api, ApiError } from '../core/api.js';
import { announce, el } from '../core/dom.js';
import { locationManager } from '../core/location.js';
import { siren, toast } from '../core/feedback.js';
import { store } from '../core/store.js';

const COUNTDOWN_MS = 10000;

let countdownTimer = null;
let armedIncident = null;

export function initSos({ onChange }) {
  store.on(['sosPhase', 'cancelSecondsLeft', 'incident', 'sirenOn'], onChange);
  void restore();
}

async function restore() {
  try {
    const { incident } = await api.activeIncident();
    if (incident && ['ACTIVE', 'ESCALATING'].includes(incident.state)) {
      store.set({ incident, sosPhase: incident.state });
      if (!siren.muted) siren.start();
    }
  } catch {
    /* boot-time check is best-effort */
  }
}

export function isEmergencyOpen() {
  const phase = store.get().sosPhase;
  return ['ARMING', 'COUNTDOWN', 'ACTIVE', 'ESCALATING'].includes(phase);
}

/** Step 1. User pressed SOS: arm server-side and run the cancel window. */
export async function arm(triggerSource = 'button') {
  if (isEmergencyOpen()) {
    toast('An emergency is already open. Use the emergency screen to stand it down.', 'warning');
    return null;
  }
  store.set({ sosPhase: 'ARMING' });
  try {
    const response = await api.armSos(triggerSource);
    armedIncident = response.incident;
    store.set({
      incident: response.incident,
      cancelSecondsLeft: Math.ceil(response.cancelWindowSeconds || COUNTDOWN_MS / 1000),
      sosPhase: 'COUNTDOWN',
    });
    startCancelCountdown();
    announce(`Emergency armed. Reference ${response.incident.reference}. Cancelling in ten seconds.`);
    return response.incident;
  } catch (error) {
    store.set({ sosPhase: 'IDLE', cancelSecondsLeft: 0 });
    if (error instanceof ApiError && error.code === 'duplicate_suppressed') {
      const active = await api.activeIncident();
      store.set({ incident: active.incident, sosPhase: active.incident?.state || 'ACTIVE' });
      toast('An emergency is already open for this account.', 'warning');
      return active.incident;
    }
    toast(error.message || 'Could not start the emergency. Check your connection.', 'error');
    return null;
  }
}

function startCancelCountdown() {
  stopCountdown();
  const tick = () => {
    const left = store.get().cancelSecondsLeft - 1;
    if (left <= 0) {
      store.set({ cancelSecondsLeft: 0 });
      stopCountdown();
      void activate();
      return;
    }
    store.set({ cancelSecondsLeft: left });
  };
  countdownTimer = window.setInterval(tick, 1000);
}

function stopCountdown() {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/** Step 2. Cancel before contacts are alerted. */
export async function cancelBeforeActivation() {
  stopCountdown();
  if (!armedIncident) {
    store.set({ sosPhase: 'IDLE', cancelSecondsLeft: 0 });
    return;
  }
  try {
    const response = await api.cancelSos('Cancelled within the countdown window');
    store.set({ incident: response.incident, sosPhase: 'IDLE', cancelSecondsLeft: 0 });
    armedIncident = null;
    toast('Emergency cancelled. No contacts were alerted.', 'info');
  } catch (error) {
    toast(error.message || 'Could not cancel the emergency.', 'error');
  }
}

/** Step 3. Acquire position, activate, report the truth. */
export async function activate() {
  stopCountdown();
  const previousPhase = store.get().sosPhase;
  store.set({ sosPhase: 'ACTIVE' });

  // Position first: a fix that arrives late is still useful, but we must not
  // delay the alert waiting for one.
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
    siren.start();
    siren.vibrate();
    store.set({ sirenOn: !siren.muted });
    announce(`Emergency active. Reference ${response.incident.reference}.`);
    reportNotifications(response);
    return response;
  } catch (error) {
    // Fall back to the previous phase so the UI does not claim to be active.
    store.set({ sosPhase: previousPhase === 'COUNTDOWN' ? 'COUNTDOWN' : previousPhase });
    if (error instanceof ApiError && error.code === 'no_open_incident') {
      store.set({ sosPhase: 'IDLE', incident: null });
      toast('The emergency expired before it could be sent. Press SOS again.', 'error');
    } else {
      toast(error.message || 'Could not send the emergency alert. Press SOS again or call 112.', 'error');
      announce('Emergency could not be sent. Call 112 now.');
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
    toast(`Alert recorded: ${parts.join(', ')}.`, 'warning', { timeout: 9000 });
  }
}

/** Stand down after contacts were alerted. */
export async function resolve(note) {
  try {
    const response = await api.resolveSos(note || 'User confirmed they are safe.');
    store.set({ incident: response.incident, sosPhase: 'RESOLVED', sirenOn: false });
    siren.stop();
    announce('Emergency stood down.');
    toast('Emergency resolved. Your contacts were told you are safe.', 'success');
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
    toast('Marked as escalating.', 'warning');
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

export function clearIncident() {
  store.set({ incident: null, sosPhase: 'IDLE', cancelSecondsLeft: 0, sirenOn: false });
  siren.stop();
}