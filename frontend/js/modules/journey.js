/**
 * Journey Guard (client side).
 *
 * The state machine is server-authoritative. This module drives the countdown,
 * asks the user to check in, and surfaces escalation. It does not claim to
 * monitor in the background - it says so, because a closed tab cannot.
 */

import { api } from '../core/api.js';
import { el, errorState, formatTime, mount, notice } from '../core/dom.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

let ticker = null;

const STATE_META = {
  ON_JOURNEY: { label: 'On journey', badge: 'badge--info', hint: 'We will ask you to check in when you should have arrived.' },
  CHECK_IN_REQUIRED: { label: 'Check-in required', badge: 'badge--warn', hint: 'Tap "I arrived safely" if you are safe, or escalate if you need help.' },
  WARNING: { label: 'No check-in received', badge: 'badge--danger', hint: 'We have not heard from you. Contacts have not been alerted automatically - escalate if you need help.' },
  EMERGENCY: { label: 'Escalated to SOS', badge: 'badge--danger', hint: 'A SheSafe SOS incident is open. Use Call 112 to reach emergency services.' },
  ARRIVED: { label: 'Arrived safely', badge: 'badge--safe', hint: 'Checked in. Journey closed.' },
  CANCELLED: { label: 'Cancelled', badge: 'badge--muted', hint: 'Journey guard stopped.' },
};

export async function loadJourney({ silent = false } = {}) {
  const panel = document.getElementById('journey-panel');
  try {
    const response = await api.activeJourney();
    store.set({ journey: response.journey, journeyRequiresAction: response.requiresAction });
    if (panel) renderJourney(panel, response.journey, response.disclaimer);
    syncTicker();
    return response.journey;
  } catch (error) {
    if (panel) mount(panel, errorState(error.message, () => loadJourney()));
    return null;
  }
}

function renderJourney(panel, journey, disclaimer) {
  if (!journey) {
    mount(
      panel,
      el(
        'div',
        { class: 'card' },
        el('h3', { class: 'card__title' }, 'Start a journey'),
        el('p', { class: 'card__hint' }, 'Tell us where you are going and how long you expect to take. We will check that you got there.'),
        journeyForm(),
        notice('info', 'Honest limitation', disclaimer),
      ),
    );
    return;
  }

  const meta = STATE_META[journey.state] || STATE_META.ON_JOURNEY;
  const remaining = secondsRemaining(journey);

  mount(
    panel,
    el(
      'div',
      { class: `card${['CHECK_IN_REQUIRED', 'WARNING', 'EMERGENCY'].includes(journey.state) ? '' : ''}` },
      el(
        'div',
        { class: 'row row--between' },
        el('h3', { class: 'card__title' }, `${journey.origin} → ${journey.destination}`),
        el('span', { class: `badge ${meta.badge}` }, meta.label),
      ),
      el('p', { class: 'card__hint' }, meta.hint),

      el(
        'div',
        { class: 'row', style: { marginTop: '14px', gap: '18px' } },
        el(
          'div',
          {},
          el('div', { class: 'countdown', dataset: { countdown: '1' } }, formatCountdown(remaining)),
          el('div', { class: 'tiny' }, `expected ${journey.expectedMinutes} min · due ${formatTime(journey.dueAt)}`),
        ),
      ),

      el(
        'div',
        { class: 'stack stack--tight', style: { marginTop: '16px' } },
        ['ON_JOURNEY', 'CHECK_IN_REQUIRED', 'WARNING'].includes(journey.state)
          ? el('button', { class: 'btn btn--safe btn--block btn--lg', type: 'button', onclick: () => checkIn(journey.id) }, '✓ I arrived safely')
          : null,
        journey.state === 'EMERGENCY'
          ? el('a', { class: 'call-112', href: 'tel:112' }, '🚨 Call 112 now')
          : ['ON_JOURNEY', 'CHECK_IN_REQUIRED', 'WARNING'].includes(journey.state)
            ? el('button', { class: 'btn btn--danger btn--block', type: 'button', onclick: () => escalate(journey.id) }, 'Escalate to SOS - I need help')
            : null,
        ['ON_JOURNEY', 'CHECK_IN_REQUIRED', 'WARNING'].includes(journey.state)
          ? el('button', { class: 'btn btn--quiet btn--block', type: 'button', onclick: () => cancelJourney(journey.id) }, 'Cancel journey')
          : null,
      ),

      el(
        'details',
        { style: { marginTop: '14px' } },
        el('summary', { class: 'tiny', style: { cursor: 'pointer', fontWeight: '700' } }, 'Honest limitation'),
        el('p', { class: 'tiny', style: { marginTop: '6px' } }, disclaimer),
      ),
    ),
  );
}

function journeyForm() {
  const form = el('form', { id: 'journey-start-form' });
  const origin = el('input', { class: 'input', id: 'journey-origin', required: true, maxlength: '120', placeholder: 'Campus gate', value: 'My starting point' });
  const destination = el('input', { class: 'input', id: 'journey-destination', required: true, maxlength: '120', placeholder: 'Home', value: 'Home' });
  const minutes = el(
    'select',
    { class: 'select', id: 'journey-minutes' },
    el('option', { value: '5' }, '5 minutes'),
    el('option', { value: '15', selected: true }, '15 minutes'),
    el('option', { value: '30' }, '30 minutes'),
    el('option', { value: '45' }, '45 minutes'),
    el('option', { value: '60' }, '60 minutes'),
    el('option', { value: '120' }, '2 hours'),
  );

  form.append(
    el('div', { class: 'stack' },
      el('div', { class: 'field' }, el('label', { for: 'journey-origin' }, 'I am travelling from'), origin),
      el('div', { class: 'field' }, el('label', { for: 'journey-destination' }, 'To'), destination),
      el('div', { class: 'field' }, el('label', { for: 'journey-minutes' }, 'Expected travel time'), minutes),
      el('button', { class: 'btn btn--brand btn--block', type: 'submit' }, 'Start journey guard'),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.startJourney({
        origin: origin.value.trim(),
        destination: destination.value.trim(),
        expectedMinutes: Number(minutes.value),
      });
      toast('Journey guard started.', 'success');
      await loadJourney({ silent: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  return form;
}

async function checkIn(id) {
  try {
    const response = await api.checkInJourney(id, 'Arrived safely');
    toast(response.checkInId ? 'Checked in. Journey closed.' : 'Checked in.', 'success');
    await loadJourney({ silent: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function escalate(id) {
  const confirmed = window.confirm('Escalate to a full SheSafe SOS? Contacts will be alerted using the configured channels. This does not call 112 - you must still do that yourself.');
  if (!confirmed) return;
  try {
    const response = await api.escalateJourney(id);
    toast(`SOS active. Reference ${response.reference}. Call 112 now.`, 'error', { timeout: 12000 });
    await loadJourney({ silent: true });
    window.location.hash = '#/home';
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function cancelJourney(id) {
  try {
    await api.cancelJourney(id);
    toast('Journey guard stopped.', 'info');
    await loadJourney({ silent: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function secondsRemaining(journey) {
  const due = new Date(journey.dueAt).getTime();
  return Math.max(0, Math.round((due - Date.now()) / 1000));
}

function formatCountdown(seconds) {
  const safe = Math.max(0, seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function syncTicker() {
  if (ticker) window.clearInterval(ticker);
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

export async function loadHistory() {
  const target = document.getElementById('journey-history');
  if (!target) return;
  try {
    const response = await api.checkIns();
    const items = response.checkIns || [];
    if (!items.length) {
      mount(target, el('p', { class: 'tiny' }, 'No check-ins recorded yet.'));
      return;
    }
    mount(
      target,
      el('ul', { class: 'list' }, ...items.map((item) =>
        el(
          'li',
          { class: 'list__item' },
          el('div', { class: 'list__icon', 'aria-hidden': 'true' }, '✓'),
          el(
            'div',
            { class: 'list__body' },
            el('div', { class: 'list__title' }, item.message),
            el('div', { class: 'list__meta' }, `${item.place_label || '—'} · ${formatTime(item.created_at)}`),
          ),
        ),
      )),
    );
  } catch {
    mount(target, el('p', { class: 'tiny' }, 'History unavailable.'));
  }
}