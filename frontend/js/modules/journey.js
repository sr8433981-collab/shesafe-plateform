/**
 * Journey Guard.
 *
 * The state machine is server-authoritative. This module drives the countdown,
 * asks the user to check in, and surfaces escalation.
 *
 * It does **not** claim to monitor in the background. A browser cannot reliably
 * wake a closed tab, so the limitation is stated on the screen — in the active
 * state, not only in a collapsed disclosure.
 */

import { api } from '../core/api.js';
import { el, mount, relativeTime } from '../core/dom.js';
import {
  card, confirmSheet, dataList, dataRow, formatClock, formatCountdown, formatStamp,
  icon, notice, pill,
} from '../core/ui.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

let ticker = null;

/** The honest limitation, reused on the dashboard and on this screen. */
export const BROWSER_LIMITATION =
  'Escalation only advances while this page is open. Browsers cannot reliably wake a closed tab, ' +
  'so SheSafe will not claim to be watching a journey in the background.';

/** The full ladder, shown in order so escalation is never a surprise. */
export const ESCALATION_LADDER = [
  { state: 'ON_JOURNEY', label: 'Journey started', tone: 'info', detail: 'We are counting down to your expected arrival.' },
  { state: 'CHECK_IN_REQUIRED', label: 'Check-in due', tone: 'caution', detail: 'We are asking if you arrived.' },
  { state: 'WARNING', label: 'No check-in received', tone: 'danger', detail: 'Nobody is alerted automatically. You escalate, or we do nothing.' },
  { state: 'EMERGENCY', label: 'Escalated to a real SOS', tone: 'danger', detail: 'A SheSafe incident is open and your contacts are being recorded as alerted.' },
];

const STATE_META = {
  ON_JOURNEY: { label: 'On journey', tone: 'info', hint: 'We will ask you to check in when you should have arrived.' },
  CHECK_IN_REQUIRED: { label: 'Check-in required', tone: 'caution', hint: 'Tap "I arrived safely" if you are safe, or escalate if you need help.' },
  WARNING: { label: 'No check-in received', tone: 'danger', hint: 'We have not heard from you. Contacts are NOT alerted automatically — escalate if you need help.' },
  EMERGENCY: { label: 'Escalated to SOS', tone: 'danger', hint: 'A SheSafe SOS incident is open. Use Call 112 to reach emergency services.' },
  ARRIVED: { label: 'Arrived safely', tone: 'safe', hint: 'Checked in. Journey closed.' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', hint: 'Journey Guard stopped.' },
};

/** Shared with the dashboard so both screens speak the same language. */
export function stateMeta(state) {
  return STATE_META[state] || { label: state || 'Not active', tone: 'neutral', hint: '' };
}

/* ------------------------------------------------------------------ data */

export async function loadJourney({ silent = false } = {}) {
  const panel = document.getElementById('journey-panel');
  if (panel && !silent) mount(panel, journeySkeleton());
  try {
    const response = await api.activeJourney();
    store.set({ journey: response.journey, journeyRequiresAction: response.requiresAction });
    if (panel) renderJourney(panel, response.journey, response.disclaimer);
    const side = document.getElementById('journey-side');
    if (side) renderJourneySide(side, response.journey, response.disclaimer);
    syncTicker();
    return response.journey;
  } catch (error) {
    if (panel) mount(panel, notice('danger', 'Could not load Journey Guard', error.message));
    return null;
  }
}

function journeySkeleton() {
  return card('Journey Guard', { body: [el('div', { class: 'skeleton skeleton--tall' })] });
}

/* ---------------------------------------------------------------- render */

function renderJourney(panel, journey, disclaimer) {
  if (!journey) {
    mount(panel, startJourneyCard(disclaimer));
    return;
  }
  const meta = stateMeta(journey.state);
  const remaining = secondsRemaining(journey);
  const contact = (store.get().contacts || []).find((c) => c.id === journey.contactId);

  mount(panel,
    card(null, {
      body: [
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title' }, `${journey.origin} → ${journey.destination}`),
            el('p', { class: 'card__hint' }, `Started ${formatStamp(journey.startedAt)} · expected ${journey.expectedMinutes} min`)),
          pill(meta.label, meta.tone, { live: ['ON_JOURNEY', 'CHECK_IN_REQUIRED'].includes(journey.state) })),

        el('p', { class: 'small' }, meta.hint),

        el('div', { class: 'row pad-block' },
          el('div', { class: 'sos-countdown', id: 'journey-countdown', dataset: { countdown: '1' }, role: 'timer', 'aria-label': 'Time until check-in is due' }, formatCountdown(remaining)),
          el('div', { class: 'metric-grid grow' },
            metricTile('Expected arrival', formatClock(journey.dueAt)),
            metricTile('Trusted contact', contact ? contact.name : 'None attached'),
            metricTile('Journey status', meta.label))),

        contact ? notice('info', `${contact.name} is attached to this journey`,
          'Their number is on the record for this journey. SheSafe cannot message them without a configured provider — check what happens on escalation before you rely on it.')
          : notice('caution', 'No trusted contact attached',
            'Nobody is attached to this journey. Add one so the record shows who would be told if you escalate.'),

        ['ON_JOURNEY', 'CHECK_IN_REQUIRED', 'WARNING'].includes(journey.state)
          ? el('div', { class: 'stack stack--tight' },
              el('button', { class: 'btn btn--safe btn--block btn--lg', type: 'button', onclick: () => void checkIn(journey.id) },
                icon('checkCircle'), 'I arrived safely'),
              journey.state === 'EMERGENCY'
                ? el('a', { class: 'call-112', href: 'tel:112' }, icon('phone'), 'Call 112 now')
                : el('button', { class: 'btn btn--danger btn--block', type: 'button', onclick: () => void escalate(journey.id) },
                    icon('siren'), 'Escalate to SOS — I need help'),
              el('button', { class: 'btn btn--quiet btn--block', type: 'button', onclick: () => void cancelJourney(journey.id) },
                icon('pause'), 'Cancel journey'))
          : null,
      ],
    }));
}

function metricTile(label, value) {
  return el('div', { class: 'metric' },
    el('div', { class: 'metric__label' }, label),
    el('div', { class: 'metric__value' }, value));
}

function renderJourneySide(side, journey, disclaimer) {
  const active = journey && ['ON_JOURNEY', 'CHECK_IN_REQUIRED', 'WARNING', 'EMERGENCY'].includes(journey.state);
  mount(side,
    card('How escalation works', {
      hint: 'The ladder, in order. Nothing happens behind your back.',
      body: [dataList(ESCALATION_LADDER.map((step_, index) => dataRow({
        iconName: step_.tone === 'danger' ? 'siren' : step_.tone === 'caution' ? 'clock' : 'checkCircle',
        title: `${index + 1}. ${step_.label}`,
        badges: [active && journey.state === step_.state ? pill('You are here', 'brand') : null],
        meta: step_.detail,
      })))],
    }),
    notice('caution', 'What a browser cannot do', disclaimer || BROWSER_LIMITATION),
    card('Recent check-ins', { body: [el('div', { id: 'journey-history' })] }));
}

function startJourneyCard(disclaimer) {
  const form = journeyForm();
  return card('Start a journey', {
    hint: 'Tell us where you are going and how long you expect to take. We will check that you got there.',
    body: [form, notice('info', 'Honest limitation', disclaimer || BROWSER_LIMITATION)],
  });
}

function journeyForm() {
  const form = el('form', { id: 'journey-start-form' });

  const origin = el('input', { class: 'input', id: 'journey-origin', required: true, maxlength: '120', placeholder: 'Where you are now', value: 'My starting point' });
  const destination = el('input', { class: 'input', id: 'journey-destination', required: true, maxlength: '120', placeholder: 'Where you are going', value: 'Home' });
  const minutes = el('select', { class: 'select', id: 'journey-minutes' },
    el('option', { value: '2' }, '2 minutes (for testing)'),
    el('option', { value: '5' }, '5 minutes'),
    el('option', { value: '15', selected: true }, '15 minutes'),
    el('option', { value: '30' }, '30 minutes'),
    el('option', { value: '45' }, '45 minutes'),
    el('option', { value: '60' }, '1 hour'),
    el('option', { value: '120' }, '2 hours'));

  const contacts = (store.get().contacts || []).filter((c) => c.active);
  const contactSelect = el('select', { class: 'select', id: 'journey-contact' },
    el('option', { value: '' }, 'No contact attached'),
    ...contacts.map((contact) => el('option', { value: contact.id }, `${contact.name}${contact.isPrimary ? ' (primary)' : ''}`)));
  if (!contacts.length) contactSelect.disabled = true;

  form.append(el('div', { class: 'stack' },
    el('div', { class: 'grid grid--2' },
      el('div', { class: 'field' }, el('label', { for: 'journey-origin' }, 'Travelling from'), origin),
      el('div', { class: 'field' }, el('label', { for: 'journey-destination' }, 'To'), destination)),
    el('div', { class: 'grid grid--2' },
      el('div', { class: 'field' }, el('label', { for: 'journey-minutes' }, 'Expected travel time'), minutes),
      el('div', { class: 'field' }, el('label', { for: 'journey-contact' }, 'Trusted contact for this journey'), contactSelect)),
    contacts.length
      ? el('p', { class: 'field__hint' }, 'The contact is attached to the journey record. SheSafe cannot message them without a configured notification provider.')
      : notice('caution', 'No active trusted contacts', 'Add at least one contact so somebody is attached to the journey record.'),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, icon('navigate'), 'Start Journey Guard')));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.startJourney({
        origin: origin.value.trim(),
        destination: destination.value.trim(),
        expectedMinutes: Number(minutes.value),
        contactId: contactSelect.value || null,
      });
      toast('Journey Guard started. You will be asked to check in.', 'success');
      await loadJourney({ silent: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  return form;
}

/* --------------------------------------------------------------- actions */

export async function checkIn(id) {
  try {
    await api.checkInJourney(id, 'Arrived safely');
    toast('Checked in. Journey closed.', 'success');
    await loadJourney({ silent: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

export async function escalate(id) {
  const confirmed = await confirmSheet({
    title: 'Escalate to a full SOS?',
    body: 'Your trusted contacts will be alerted using their configured channels, and an incident is recorded. '
      + 'This does not call 112 — you must still do that yourself.',
    confirmLabel: 'Escalate to SOS',
    tone: 'danger',
    iconName: 'siren',
  });
  if (!confirmed) return;
  try {
    const response = await api.escalateJourney(id);
    toast(`SOS active. Reference ${response.reference}. Call 112 now.`, 'error', { timeout: 14000 });
    await loadJourney({ silent: true });
    window.location.hash = '#/home';
  } catch (error) {
    toast(error.message, 'error');
  }
}

export async function cancelJourney(id) {
  const confirmed = await confirmSheet({
    title: 'Cancel Journey Guard?',
    body: 'The countdown stops and nobody is contacted.',
    confirmLabel: 'Cancel journey',
    tone: 'quiet',
    iconName: 'pause',
  });
  if (!confirmed) return;
  try {
    await api.cancelJourney(id);
    toast('Journey Guard stopped.', 'info');
    await loadJourney({ silent: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------------------------------------------------------------- ticker */

function secondsRemaining(journey) {
  const due = new Date(journey.dueAt).getTime();
  return Math.max(0, Math.round((due - Date.now()) / 1000));
}

function syncTicker() {
  if (ticker) { window.clearInterval(ticker); ticker = null; }
  const journey = store.get().journey;
  if (!journey || !['ON_JOURNEY', 'CHECK_IN_REQUIRED', 'WARNING'].includes(journey.state)) return;
  ticker = window.setInterval(() => {
    const node = document.querySelector('[data-countdown="1"]');
    if (!node) return;
    const remaining = secondsRemaining(store.get().journey || journey);
    node.textContent = formatCountdown(remaining);
    if (remaining <= 0) {
      window.clearInterval(ticker);
      ticker = null;
      void loadJourney({ silent: true });
    }
  }, 1000);
}

/* --------------------------------------------------------------- history */

export async function loadHistory() {
  const target = document.getElementById('journey-history');
  if (!target) return;
  try {
    const response = await api.checkIns();
    const items = response.checkIns || [];
    if (!items.length) {
      mount(target, el('p', { class: 'small' }, 'No check-ins recorded yet.'));
      return;
    }
    mount(target, dataList(items.map((item) => dataRow({
      iconName: 'checkCircle',
      title: item.message,
      meta: `${item.place_label || '—'} · ${relativeTime(item.created_at)}`,
    }))));
  } catch (error) {
    mount(target, notice('caution', 'Check-in history unavailable', error.message));
  }
}
