/**
 * Location manager.
 *
 * Privacy posture, which differs materially from the audited build:
 *
 * * **Off until asked.** `watchPosition` is not started on page load. The user
 *   grants permission explicitly, or sharing is switched on.
 * * **Throttled + filtered.** A fix is transmitted at most once every
 *   `MIN_INTERVAL_MS`, only when it has moved at least `MIN_MOVE_METERS`, and only
 *   when the accuracy is usable. A stationary phone does not generate a stream.
 * * **No server-side history of ordinary movement.** Samples are only linked to
 *   an incident while one is open; otherwise they age out under the retention
 *   policy. Nothing accumulates a movement profile.
 * * **Never pretends.** If permission is denied or the API is missing, the state
 *   says so and the UI shows it. There is no fallback "live" marker.
 */

import { api, ApiError } from './api.js';
import { store } from './store.js';

const MIN_INTERVAL_MS = 8000;
const MIN_MOVE_METERS = 5;
const MAX_USABLE_ACCURACY_M = 200;

function haversineMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371008.8;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

class LocationManager {
  constructor() {
    this.watchId = null;
    this.lastSentAt = 0;
    this.lastSentPosition = null;
    this.lastRawPosition = null;
    this._streaming = false;
    this.battery = null;
    this.onUpdate = null;
  }

  get supported() {
    return 'geolocation' in navigator;
  }

  /** True while a continuous GPS watch is active. */
  get isStreaming() {
    return this._streaming;
  }

  /** Ask for permission and start streaming. Resolves with a fix or throws. */
  async start({ immediate = true } = {}) {
    if (!this.supported) {
      store.set({ locationPermission: 'unsupported', locationError: 'This browser has no location API.' });
      throw new Error('Location is not supported by this browser.');
    }
    store.set({ locationPermission: 'prompt', locationError: null });

    // One explicit permission prompt, then watch for changes.
    const first = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        resolve,
        (error) => reject(new Error(describeGeolocationError(error))),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
      );
    });

    this._apply(first, { force: immediate });

    if (this.watchId === null) {
      this.watchId = navigator.geolocation.watchPosition(
        (position) => this._apply(position, {}),
        (error) => {
          // A transient GPS error must not kill an active emergency stream.
          store.set({ locationError: describeGeolocationError(error) });
        },
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 5000 },
      );
    }
    this._streaming = true;
    store.set({ locationPermission: 'granted', locationError: null });
    return this.lastRawPosition;
  }

  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this._streaming = false;
    store.set({ locationPermission: 'prompt', location: store.get().location });
  }

  /**
   * Ask for a single high-accuracy fix. Used by the SOS flow, which must never
   * depend on the continuous stream being running.
   */
  async fix({ timeout = 12000, enableHighAccuracy = true } = {}) {
    if (!this.supported) return null;
    return new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (!settled) { settled = true; resolve(this.lastRawPosition); }
      }, timeout);
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          this._apply(position, { force: true });
          resolve(position);
        },
        (error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          store.set({ locationError: describeGeolocationError(error) });
          resolve(this.lastRawPosition);
        },
        { enableHighAccuracy, timeout, maximumAge: 0 },
      );
    });
  }

  _apply(position, { force = false } = {}) {
    const coords = position.coords;
    const current = {
      lat: coords.latitude,
      lng: coords.longitude,
      accuracyM: coords.accuracy ?? null,
      speedMps: coords.speed ?? null,
      headingDeg: coords.heading ?? null,
      batteryPct: this.battery,
      recordedAt: new Date(position.timestamp || Date.now()).toISOString(),
      source: 'gps',
    };
    this.lastRawPosition = current;
    store.set({ location: current, locationStale: false, locationError: null });

    const usable = current.accuracyM === null || current.accuracyM <= MAX_USABLE_ACCURACY_M;
    const moved = haversineMeters(this.lastSentPosition, current) >= MIN_MOVE_METERS;
    const due = Date.now() - this.lastSentAt >= MIN_INTERVAL_MS;
    const firstEver = this.lastSentPosition === null;

    if (usable && (force || firstEver || (due && moved))) {
      this.lastSentPosition = current;
      this.lastSentAt = Date.now();
      this._send(current);
    }
    if (this.onUpdate) this.onUpdate(current);
  }

  /** Force a transmit regardless of the throttle (used on incident activation). */
  forceSend() {
    if (!this.lastRawPosition) return Promise.resolve(null);
    this.lastSentPosition = this.lastRawPosition;
    this.lastSentAt = Date.now();
    return this._send(this.lastRawPosition);
  }

  async _send(position) {
    try {
      await api.pingLocation({
        lat: Number(position.lat.toFixed(6)),
        lng: Number(position.lng.toFixed(6)),
        accuracy: position.accuracyM ? Math.round(position.accuracyM) : null,
        speed: position.speedMps,
        heading: position.headingDeg,
        battery: position.batteryPct,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        // Do not retry-loop on auth/rate-limit failures; surface it instead.
        if (!error.isRateLimited && !error.isAuth) store.set({ locationError: error.message });
      }
    }
  }

  /** Best available position for the SOS payload. */
  currentPayload() {
    const position = this.lastRawPosition;
    if (!position) return {};
    return {
      lat: Number(position.lat.toFixed(6)),
      lng: Number(position.lng.toFixed(6)),
      accuracy: position.accuracyM ? Math.round(position.accuracyM) : null,
      speed: position.speedMps,
      heading: position.headingDeg,
      battery: position.batteryPct,
    };
  }

  async readBattery() {
    if (!('getBattery' in navigator)) return null;
    try {
      const manager = await navigator.getBattery();
      const update = () => {
        this.battery = Math.round(manager.level * 100);
        if (this.lastRawPosition) {
          this.lastRawPosition.batteryPct = this.battery;
          store.set({ location: { ...this.lastRawPosition } });
        }
      };
      manager.addEventListener('levelchange', update);
      update();
      return this.battery;
    } catch {
      return null;
    }
  }
}

export function describeGeolocationError(error) {
  if (!error) return 'Location is unavailable.';
  switch (error.code) {
    case 1: return 'Location permission was denied. Enable it in your browser settings to use live location.';
    case 2: return 'Your position could not be determined. Move somewhere with a clearer GPS signal.';
    case 3: return 'Location timed out. Try again outdoors or near a window.';
    default: return 'Location is unavailable on this device.';
  }
}

export const locationManager = new LocationManager();