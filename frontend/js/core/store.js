/**
 * Tiny observable store. Enough state management for a single-page app without
 * pulling in a framework: a plain object, a subscribe list, and immutable-ish
 * updates that re-render only the subscribers that asked for a key.
 */

export function createStore(initial) {
  let state = { ...initial };
  const subscribers = new Set();
  const keySubscribers = new Map();

  function get() {
    return state;
  }

  function set(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (state[key] !== value) {
        state = { ...state, [key]: value };
        changed.push(key);
      }
    }
    if (changed.length) {
      subscribers.forEach((fn) => fn(state, changed));
      changed.forEach((key) => {
        (keySubscribers.get(key) || []).forEach((fn) => fn(state[key], state));
      });
    }
    return state;
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function on(keys, fn) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      if (!keySubscribers.has(key)) keySubscribers.set(key, new Set());
      keySubscribers.get(key).add(fn);
    }
    return () => {
      for (const key of list) (keySubscribers.get(key) || new Set()).delete(fn);
    };
  }

  return { get, set, subscribe, on };
}

export const store = createStore({
  // session
  user: null,
  authenticated: false,
  sessionChecked: false,
  demoMode: false,
  capabilities: null,

  // location
  location: null,
  locationAgeSeconds: null,
  locationStale: true,
  locationPermission: 'prompt', // prompt | granted | denied | unsupported
  locationError: null,
  sharingActive: false,

  // emergency
  incident: null,
  sosPhase: 'IDLE', // IDLE | ARMING | COUNTDOWN | ACTIVE | ESCALATING | RESOLVED | CANCELLED
  cancelSecondsLeft: 0,
  sirenOn: false,
  voiceListening: false,

  // journeys
  journey: null,
  journeyRequiresAction: false,

  // ui
  contacts: [],
  view: 'home',
  busy: new Set(),
});

export const actions = {
  markBusy(key, value = true) {
    const busy = new Set(store.get().busy);
    if (value) busy.add(key); else busy.delete(key);
    store.set({ busy });
  },
  isBusy(key) {
    return store.get().busy.has(key);
  },
};