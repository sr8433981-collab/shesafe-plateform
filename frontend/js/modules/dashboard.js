/**
 * Dashboard.
 *
 * The dashboard is the three-second read. It is ordered by what a person needs
 * in order to decide something:
 *
 *   1. the emergency control (or, during an emergency, the emergency console),
 *   2. the current safety status,
 *   3. Journey Guard,
 *   4. live location,
 *   5. trusted contacts,
 *   6. nearby safe places,
 *   7. safety intelligence.
 *
 * There is no card grid and no "quick actions" list: navigation lives in the
 * navigation, not in the content.
 */

import { api } from '../core/api.js';
import { $, el, mount, relativeTime } from '../core/dom.js';
import {
  BAND_TONE, DELIVERY_TONE, card, confirmSheet, dataList, dataRow, disclosure,
  icon, metric, metricGrid, notice, pill, safetyTimeline, skeletonList,
} from '../core/ui.js';
import { locationManager } from '../core/location.js';
import { store } from '../core/store.js';
import { toast } from '../core/feedback.js';

import * as contacts from './contacts.js';
import * as intelligence from './intelligence.js';
import * as journey from './journey.js';
import * as places from './places.js';
import * as sharing from './sharing.js';
import * as sos from './sos.js';

/* ---------------------------------------------------------------- helpers */

function capability(id) {
  const list = store.get().capabilities || [];
  return list.find((c) => c.id === id) || null;
}

/** SheSafe never contacts emergency services unless a provider says it can. */
export function emergencyServicesCapability() {
  const cap = capability('police_dispatch');
  const real = cap && cap.mode === 'real';
  return {
    available: Boolean(real),
    label: real ? 'AVAILABLE' : 'UNAVAILABLE',
    detail: cap ? cap.detail : 'SheSafe does not contact police or ambulance.',
  };
}

/* ------------------------------------------------------------ 1. emergency */

/** The ready state: one dominant control, one honest dialler action. */
function sosDock() {
  const orb = el(
    'button',
    { class: 'sos-orb', id: 'btn-sos', type: 'button', dataset: { phase: 'ready' },
      'aria-label': 'Start an emergency SOS. Press and hold for one second, or press Enter.' },
    el('span', { class: 'sos-orb__ring', 'aria-hidden': 'true' }),
    el('span', {},
      el('span', { class: 'sos-orb__label' }, 'SOS'),
      // `el()` sets textContent, so an HTML entity here would print literally.
      el('span', { class: 'sos-orb__sub' }, 'Press & hold')),
  );
  sos.mountTrigger(orb);

  return el('div', { class: 'sos-dock' },
    el('div', { class: 'stack', dataset: { slot: 'action' } },
      orb,
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn--danger-ghost btn--block', type: 'button', id: 'btn-sos-quick', onclick: () => void sos.arm('button') },
          icon('siren'), 'Arm now with one tap'),
        el('button', { class: 'btn btn--quiet btn--block', type: 'button', id: 'btn-siren-toggle', 'aria-pressed': String(Boolean(store.get().sirenOn)), onclick: onSirenToggle },
          icon(store.get().sirenOn ? 'volume' : 'mute'), store.get().sirenOn ? 'Siren on' : 'Siren off'))),
    el('div', { class: 'stack', dataset: { slot: 'side' } },
      el('div', { class: 'section-title' }, 'If you need emergency services'),
      el('a', { class: 'call-112', href: 'tel:112' }, icon('phone'), 'Call 112'),
      el('p', { class: 'small' },
        '112 reaches police, fire and ambulance in India. SheSafe cannot place the call for you — ' +
        'this button opens your phone’s dialler and you press call.'),
      el('a', { class: 'btn btn--quiet btn--block', type: 'button', id: 'btn-voice-sos', onclick: () => window.dispatchEvent(new CustomEvent('shesafe:voice')) },
        icon('mic'), 'Voice SOS'),
      disclosure('Other emergency numbers', el('div', { id: 'helpline-list' }))),
    el('div', { class: 'stack', dataset: { slot: 'side' } }));
}

/** Published emergency numbers, rendered from the store on every paint. */
function helplineList() {
  const target = document.getElementById('helpline-list');
  if (!target) return;
  const helplines = store.get().helplines || [];
  if (!helplines.length) {
    mount(target, el('p', { class: 'small' }, 'Loading published numbers…'));
    return;
  }
  mount(target,
    dataList(helplines.map((line) => dataRow({
      iconName: 'phone',
      title: line.title,
      badges: [pill(line.category, 'neutral')],
      meta: line.note,
      actions: [el('a', { class: 'btn btn--quiet btn--sm', href: `tel:${line.number}`, 'aria-label': `Call ${line.title} on ${line.number}` }, line.number)],
    }))));
}

/** The cancel window. Big number, one obvious way out. */
function countdownConsole(incident, secondsLeft) {
  return el('div', { class: 'sos-dock', dataset: { slot: 'countdown' } },
    el('div', { class: 'stack' },
      el('div', { class: 'section-title' }, 'Cancel window open'),
      el('div', { class: 'sos-countdown', id: 'sos-countdown', role: 'timer', 'aria-live': 'off' }, String(secondsLeft)),
      el('p', { class: 'small' },
        `Emergency alert will activate in ${secondsLeft} second${secondsLeft === 1 ? '' : 's'}. ` +
        `Reference ${incident?.reference || 'pending'}.`),
      el('button', { class: 'btn btn--danger btn--block btn--lg', type: 'button', id: 'btn-sos-cancel', onclick: () => void sos.cancelBeforeActivation() },
        icon('x'), 'Cancel the emergency'),
      el('p', { class: 'small' }, 'Nothing has been sent to anyone yet. Cancelling is immediate and free.')),
    el('div', { class: 'stack' },
      el('div', { class: 'section-title' }, 'What happens next'),
      el('ol', { class: 'stack stack--tight plain-list' },
        step('1', 'Your position is captured with its GPS accuracy.'),
        step('2', 'Your trusted contacts are alerted on the channels you chose.'),
        step('3', 'An expiring live-tracking link is created for them to follow.'),
        step('4', 'A SheSafe incident record is written, with every step timestamped.')),
      notice('danger', 'SheSafe will not contact police',
        'After the countdown, SheSafe records the incident and alerts your contacts. ' +
        'It does not call 112, 100 or 108. If you need emergency services, call 112 now.')));
}

/** The in-flight state between the countdown ending and the server responding. */
function activatingConsole(incident) {
  return el('div', { class: 'sos-dock', dataset: { slot: 'activating' } },
    el('div', { class: 'stack' },
      el('div', { class: 'section-title' }, 'Cancel window expired'),
      el('div', { class: 'sos-countdown', id: 'sos-activating', role: 'status' }, '···'),
      el('h2', { class: 'card__title' }, 'Activating'),
      el('p', { class: 'small' },
        `Capturing your position and recording incident ${incident?.reference || ''}. ` +
        'The cancel window has closed; nothing is claimed until the server confirms it.'),
      el('a', { class: 'call-112', href: 'tel:112' }, icon('phone'), 'Call 112 now')),
    el('div', { class: 'stack' },
      el('div', { class: 'section-title' }, 'While this completes'),
      el('p', { class: 'small' }, 'SheSafe is contacting your trusted contacts on the channels you chose and creating a tracking link.'),
      notice('danger', 'This does not reach emergency services',
        '112 is still a call you place yourself. Press it now if you need police, fire or ambulance.')));
}

function step(number, text) {
  return el('li', { class: 'row row--tight' },
    el('span', { class: 'demo-step__n', 'aria-hidden': 'true' }, number),
    el('span', { class: 'small grow' }, text));
}

/**
 * The active emergency console.
 *
 * This is an emergency interface, so it is ordered by what someone needs first
 * and nothing else is on it:
 *
 *   1. SOS ACTIVE and the incident reference, read out loud
 *   2. Call 112 and Stand down — the only two actions
 *   3. the six facts that say what is actually happening
 *   4. per-contact delivery, with the real outcome
 *   5. the incident timeline
 *
 * Every value is read from the server response. Nothing here is inferred from
 * client state, because during an emergency the worst possible bug is a screen
 * that looks fine while disagreeing with the record.
 */
function activeConsole(incident, { escalated }) {
  const services = emergencyServicesCapability();
  const location = incident.location;
  const notifications = incident.notifications || [];
  const summary = incident.notificationSummary || {};
  const sharingActive = store.get().sharingActive || Boolean(incident.id);
  const ageSeconds = location?.recordedAt
    ? Math.max(0, Math.round((Date.now() - new Date(location.recordedAt).getTime()) / 1000))
    : null;

  return el('div', { class: 'emergency', dataset: { slot: 'active' } },
    /* 1. what is happening */
    el('div', { class: 'emergency__head' },
      el('div', {},
        el('div', { class: 'emergency__title' }, escalated ? 'ESCALATING' : 'SOS ACTIVE'),
        el('div', { class: 'emergency__ref' }, `Incident ${incident.reference}`),
        el('p', { class: 'emergency__note' },
          incident.activatedAt
            ? `Raised ${new Date(incident.activatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
            : 'Raised just now')),
      pill(escalated ? 'Escalating' : 'Active', 'danger', { live: true })),

    /* 2. the two actions, above everything else */
    el('div', { class: 'emergency__actions' },
      el('a', { class: 'call-112 btn--block', href: 'tel:112' }, icon('phone'), 'Call 112 now'),
      el('p', { class: 'emergency__note emergency__note--center' },
        '112 is the only route to emergency services from SheSafe. The call is placed by you, on your device.'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn--on-dark btn--block', type: 'button', onclick: () => void sos.escalate() },
          icon('siren'), 'Mark escalating'),
        el('button', { class: 'btn btn--on-dark btn--block', type: 'button', id: 'btn-sos-stand-down', onclick: () => void standDown() },
          icon('checkCircle'), 'I am safe — stand down'))),

    /* 3. the six facts */
    el('div', { class: 'emergency-grid' },
      cell('Location', location ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : 'Not captured'),
      cell('GPS accuracy', location?.accuracyM != null ? `±${Math.round(location.accuracyM)} m` : 'Unknown'),
      cell('Location age', ageSeconds != null ? formatAge(ageSeconds) : 'Unknown'),
      cell('Location sharing', sharingActive ? 'ACTIVE' : 'INACTIVE'),
      cell('Trusted contacts', contactState(summary, notifications.length)),
      cell('Emergency services', services.label, services.available ? null : services.detail)),

    /* 4. delivery, with the real outcome */
    el('div', { class: 'card__foot' },
      el('div', { class: 'section-title' }, 'Contact delivery — recorded, not assumed'),
      notifications.length
        ? dataList(notifications.slice(0, 8).map((attempt) => deliveryRow(attempt)))
        : el('p', { class: 'small' }, 'No contact notification was attempted. Add a trusted contact so somebody can be told.'),
      summary.statement ? el('p', { class: 'small' }, summary.statement) : null),

    /* 5. the record */
    (incident.safetyTimeline || incident.timeline || []).length
      ? el('div', { class: 'card__foot' },
          el('div', { class: 'section-title' }, 'Incident timeline'),
          safetyTimeline(incident.safetyTimeline || incident.timeline, { showTypes: false }))
      : null);
}

/** Location age in one short phrase. Seconds matter when the fix is old. */
function formatAge(seconds) {
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/** One honest word-pair about the contacts, from the server's own counts. */
function contactState(summary, attempted) {
  if (!attempted) return 'None configured';
  if (summary.delivered) return `${summary.delivered} delivered`;
  if (summary.simulated) return `${summary.simulated} simulated`;
  if (summary.failed) return `${summary.failed} failed`;
  if (summary.unavailable) return `${summary.unavailable} unavailable`;
  return 'Recorded';
}

function cell(label, value, detail = null) {
  return el('div', { class: 'emergency-cell' },
    el('div', { class: 'emergency-cell__label' }, label),
    el('div', { class: 'emergency-cell__value' }, value),
    detail ? el('div', { class: 'emergency-cell__detail' }, detail) : null);
}

function deliveryRow(attempt) {
  const spec = DELIVERY_TONE[attempt.status] || DELIVERY_TONE.unavailable;
  return dataRow({
    iconName: spec.tone === 'safe' ? 'checkCircle' : spec.tone === 'danger' ? 'alert' : 'info',
    title: `${String(attempt.channel || '').toUpperCase()} — ${spec.word}`,
    badges: [pill(spec.word, spec.tone)],
    meta: [attempt.provider ? `via ${attempt.provider}` : null, attempt.detail || null].filter(Boolean).join(' · '),
  });
}

async function standDown() {
  const ok = await confirmSheet({
    title: 'Stand down this emergency?',
    body: 'Your contacts will be recorded as told that you are safe. The incident record is kept with its full timeline.',
    confirmLabel: 'I am safe — stand down',
    tone: 'safe',
    iconName: 'checkCircle',
  });
  if (!ok) return;
  await sos.resolve('User confirmed they are safe.');
}

/* ------------------------------------------------------- 2. safety status */

/**
 * The five-second read.
 *
 * One dial, one band, three numbers and two links. If a reader takes in nothing
 * else, they should still know how safe this place looks, how much data that
 * rests on, and where to go to be convinced. Anything that does not answer one
 * of those lives further down.
 */
function safetyStatusPanel() {
  const assessment = store.get().assessment;
  if (!assessment) {
    return card('Current safety status', {
      hint: 'An explainable, rule-based estimate for where you are right now.',
      body: [assessmentSkeleton()],
    });
  }

  const tone = BAND_TONE[assessment.band] || 'neutral';
  const coverage = coverageLabel(assessment);
  const comparison = store.get().comparison;

  return el('section', { class: 'card', id: 'safety-status-card' },
    el('div', { class: 'card__head' },
      el('div', {},
        el('h2', { class: 'card__title' }, 'Current safety status'),
        el('p', { class: 'card__hint' }, `${assessment.context?.hourLocal != null ? `${String(assessment.context.hourLocal).padStart(2, '0')}:00 local` : 'Your local time'} · ${assessment.modelDescription || 'Rule-based estimate'}`)),
      pill(assessment.band, tone)),

    el('div', { class: 'row score-row' },
      intelligence.scoreDial(assessment.safetyScore, assessment.band),
      el('div', { class: 'stack stack--tight grow' },
        el('div', { class: 'metric-grid' },
          metric('Risk', assessment.riskScore, { tone }),
          metric('Confidence', `${Math.round(assessment.confidence * 100)}%`),
          metric('Coverage', coverage.label)),
        el('p', { class: 'small' }, assessment.confidenceLabel),
        coverage.tone !== 'safe' ? el('p', { class: 'small' }, coverage.note) : null,
        el('div', { class: 'row row--tight' },
          el('a', { class: 'btn btn--primary btn--sm', href: '#/intelligence' }, icon('gauge'), 'Why this score?'),
          el('a', { class: 'btn btn--quiet btn--sm', href: '#/route' }, icon('route'), 'Find a safer route')))),

    // Safety is not a constant. When a comparison has been run, the dashboard
    // shows the movement rather than making the user open another screen.
    comparison && comparison.dimensionLabel
      ? el('div', { class: 'card__foot' },
          el('div', { class: 'section-title' }, `What changed — ${comparison.dimensionLabel.toLowerCase()}`),
          comparison.limited
            ? el('p', { class: 'small' }, comparison.limitedNote)
            : el('div', { class: 'row row--tight' },
                el('span', { class: 'change__stage' },
                  el('span', { class: 'change__stage-label' }, 'Was'),
                  el('span', { class: 'change__score-value change__score-value--sm' }, String(comparison.before.safetyScore))),
                el('span', { 'aria-hidden': 'true' }, icon('arrowRight')),
                el('span', { class: 'change__stage' },
                  el('span', { class: 'change__stage-label' }, 'Now'),
                  el('span', { class: 'change__score-value change__score-value--sm' }, String(comparison.after.safetyScore))),
                el('span', { class: 'small grow' },
                  comparison.primaryFactor
                    ? `${comparison.primaryFactor.label}: ${comparison.primaryFactor.afterReason}`
                    : 'No factor moved.')),
          el('a', { class: 'btn btn--quiet btn--sm', href: '#/intelligence' }, 'See the full explanation'))
      : null);
}

const COVERAGE_WORDS = { GOOD: 'Good', THIN: 'Thin', POOR: 'Poor' };

/**
 * Coverage is a server-computed ratio, so the wording here must agree with it.
 * The dashboard adds the actionable sentence; the ratio itself is never
 * recomputed on the client.
 */
function coverageLabel(assessment) {
  const coverage = assessment.coverage || {};
  const label = coverage.label || 'POOR';
  const tone = { GOOD: 'safe', THIN: 'caution', POOR: 'danger' }[label] || 'danger';
  return {
    tone,
    label: COVERAGE_WORDS[label] || label,
    note: label === 'GOOD' ? '' : (coverage.note || 'Limited safety data available.'),
  };
}

function assessmentSkeleton() {
  return el('div', { class: 'row score-row' },
    el('div', { class: 'skeleton skeleton--circle' }),
    el('div', { class: 'stack stack--tight grow' },
      skeletonList(3)));
}

/* ------------------------------------------------------------- 3. journey */

function journeyStrip() {
  const journeyState = store.get().journey;
  const config = journey.stateMeta(journeyState?.state);

  return card('Journey Guard', {
    hint: 'We ask if you arrived. If you do not answer, we escalate.',
    action: journeyState ? pill(config.label, config.tone, { live: ['ON_JOURNEY', 'CHECK_IN_REQUIRED'].includes(journeyState.state) }) : pill('Not active', 'neutral'),
    body: [
      journeyState
        ? el('div', { class: 'stack stack--tight' },
            el('p', {}, el('strong', {}, journeyState.origin), ' → ', el('strong', {}, journeyState.destination)),
            el('p', { class: 'small' }, config.hint),
            ['ON_JOURNEY', 'CHECK_IN_REQUIRED', 'WARNING'].includes(journeyState.state)
              ? el('div', { class: 'btn-row' },
                  el('button', { class: 'btn btn--safe btn--block', type: 'button', onclick: () => void journey.checkIn(journeyState.id) },
                    icon('checkCircle'), 'I arrived safely'),
                  el('a', { class: 'btn btn--quiet btn--block', href: '#/journey' }, 'Open Journey Guard'))
              : null)
        : el('div', { class: 'stack stack--tight' },
            el('p', { class: 'small' }, 'No journey is being watched. Start one before you travel somewhere unfamiliar or late.'),
            el('a', { class: 'btn btn--primary btn--block', href: '#/journey' }, icon('navigate'), 'Start a journey')),
      el('p', { class: 'small' }, journey.browserLimitation),
    ],
  });
}

/* ------------------------------------------------------------ 4. location */

function locationStrip() {
  const { location, locationPermission, locationError, sharingActive } = store.get();
  const streaming = locationManager.isStreaming;

  const status = streaming ? (sharingActive ? 'Sharing live' : 'GPS on, not sharing') : 'Location off';

  return card('Live location', {
    hint: 'Off until you switch it on. Never recorded on page load.',
    action: pill(status, streaming ? 'safe' : 'neutral', { live: sharingActive }),
    body: [
      location
        ? metricGrid([
            metric('Accuracy', `±${Math.round(location.accuracyM || 0)}`, { unit: 'm' }),
            metric('Last fix', relativeTime(location.recordedAt)),
            metric('Links active', String(store.get().shares?.length ?? '—')),
          ])
        : el('p', { class: 'small' }, locationError || 'Enable location so SOS can attach a position, guardians can follow you, and the safety score has something to score.'),
      location ? el('p', { class: 'mono' }, `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`) : null,
      el('div', { class: 'btn-row' },
        streaming
          ? el('button', { class: 'btn btn--quiet btn--block', type: 'button', onclick: () => void toggleLocation() }, icon('pause'), 'Stop location')
          : el('button', { class: 'btn btn--primary btn--block', type: 'button', id: 'btn-location-toggle', onclick: () => void toggleLocation() }, icon('target'), 'Enable location'),
        el('a', { class: 'btn btn--quiet btn--block', href: '#/sharing' }, 'Sharing settings')),
      locationPermission === 'denied'
        ? notice('caution', 'Location permission denied', 'Enable it in your browser settings. SOS still works, but it will record the incident without a position.')
        : null,
    ],
  });
}

export async function toggleLocation() {
  if (locationManager.isStreaming) {
    locationManager.stop();
    toast('Location streaming stopped. Your last fix is retained until the retention window expires.', 'info');
    renderDashboard();
    return;
  }
  try {
    await locationManager.start();
    toast('Location on. Your position is used for SOS, sharing and safety scores — nothing else.', 'success', { timeout: 7000 });
  } catch (error) {
    toast(error.message, 'warning', { timeout: 9000 });
  }
  renderDashboard();
}

/* ------------------------------------------------------------ 5. contacts */

function contactsStrip() {
  const list = store.get().contacts || [];
  const active = list.filter((c) => c.active);
  const verified = active.filter((c) => c.verified);
  const channels = new Set();
  for (const contact of active) for (const channel of contact.channels || []) channels.add(channel);

  return card('Trusted contacts', {
    hint: 'Who SheSafe tries to alert, and how well that will actually work.',
    action: pill(active.length ? `${active.length} active` : 'None', active.length ? 'safe' : 'danger'),
    body: [
      active.length === 0
        ? el('p', { class: 'small' }, 'No trusted contact is configured. An SOS will record the incident and tell you to call 112, but nobody will be told.')
        : el('div', { class: 'stack stack--tight' },
            metricGrid([
              metric('Active', String(active.length)),
              metric('Self-confirmed', `${verified.length}/${active.length}`),
              metric('Channels', [...channels].map((c) => c.toUpperCase()).join(' · ') || '—'),
            ]),
            el('ul', { class: 'stack stack--tight' }, ...active.slice(0, 3).map((contact) =>
              el('li', { class: 'row row--tight' },
                icon('users'),
                el('span', { class: 'grow' }, contact.name),
                pill(contact.verified ? 'Confirmed' : 'Unconfirmed', contact.verified ? 'safe' : 'neutral')))),
            active.length > 3 ? el('p', { class: 'small' }, `and ${active.length - 3} more`) : null),
      !verified.length && active.length
        ? notice('caution', 'No contact is confirmed', 'SheSafe cannot verify that a number belongs to the person you named. Confirm each contact with them directly, or add a provider-verified step in settings.')
        : null,
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn--primary btn--block', type: 'button', 'data-open-modal': 'sheet-contacts' }, icon('users'), 'Manage contacts'),
        el('a', { class: 'btn btn--quiet btn--block', href: '#/history' }, icon('archive'), 'Past incidents')),
    ],
  });
}

/* -------------------------------------------------------------- 6. places */

function placesStrip(places_ = null) {
  const list = places_ || [];
  return card('Nearby safe places', {
    hint: 'Real OpenStreetMap places, distances from your actual fix.',
    action: pill(list.length ? `${list.length} found` : 'No position', list.length ? 'info' : 'neutral'),
    body: [
      list.length
        ? el('div', { class: 'stack stack--tight' }, ...list.slice(0, 3).map((place) => {
            const style = places.categoryStyle(place.category);
            return el('div', { class: 'row row--tight' },
              el('span', { class: 'dlist__icon', 'aria-hidden': 'true' }, icon(style.iconName)),
              el('span', { class: 'grow stack stack--tight' },
                el('strong', {}, place.name),
                el('span', { class: 'small' }, `${style.label} · ${place.distanceText} · ${place.etaMinutesWalk} min walk`)),
              place.phone
                ? el('a', { class: 'btn btn--quiet btn--sm', href: `tel:${String(place.phone).replace(/[^+\d]/g, '')}`, 'aria-label': `Call ${place.name}` }, 'Call')
                : null);
          }))
        : el('p', { class: 'small' }, 'Enable location to find real police stations, hospitals, pharmacies and women’s support centres near you.'),
      el('a', { class: 'btn btn--quiet btn--block', href: '#/places' }, icon('hospital'), 'Open safe places'),
    ],
  });
}

/* ------------------------------------------------------- 7. intelligence */

function intelligenceStrip() {
  const assessment = store.get().assessment;
  const ledger = assessment?.ledger || {};
  // The dashboard shows the two strongest movements, with their sign. A number
  // without its direction is not actionable, so nothing unsigned is shown here.
  const raising = (ledger.raising || []).slice(0, 2);
  const lowering = (ledger.lowering || []).slice(0, 1);

  return card('Safety intelligence', {
    hint: 'Six weighted rules, visible arithmetic, honest confidence.',
    action: assessment ? pill(assessment.band, BAND_TONE[assessment.band] || 'neutral') : pill('Not scored', 'neutral'),
    body: [
      assessment
        ? el('div', { class: 'stack stack--tight' },
            raising.length || lowering.length
              ? null
              : el('p', { class: 'small' },
                  'No factor moved away from its baseline, so this score is close to the '
                  + 'engine\'s starting assumption. Read the coverage, not the score.'),
            ...raising.map((factor) => movement(factor, 'risk')),
            ...lowering.map((factor) => movement(factor, 'safe')))
        : el('p', { class: 'small' }, 'A safety score needs a position. Enable location and SheSafe will score where you are.'),
      el('div', { class: 'btn-row' },
        el('a', { class: 'btn btn--primary btn--block', href: '#/intelligence' }, icon('gauge'), 'Explain the score'),
        el('a', { class: 'btn btn--quiet btn--block', href: '#/route' }, icon('route'), 'Compare routes')),
    ],
  });
}

function movement(factor, tone) {
  const sign = factor.deltaPoints >= 0 ? '+' : '−';
  return el('div', { class: 'row row--tight' },
    el('span', { class: 'ledger__delta', dataset: { tone } },
      `${sign}${Math.abs(factor.deltaPoints).toFixed(1)}`),
    el('span', { class: 'small grow' },
      el('strong', {}, factor.label), ' — ', factor.reason));
}

/* -------------------------------------------------------------- secondary */

/**
 * The rest of the product.
 *
 * These four screens are real and reachable, but none of them is something a
 * person needs in the first five seconds, so they get one quiet row rather than
 * competing cards. Nothing here is removed — it is ranked.
 */
function secondaryStrip() {
  const entries = [
    { route: 'history', label: 'Incident history', iconName: 'archive' },
    { route: 'reports', label: 'Community safety', iconName: 'community' },
    { route: 'assist', label: 'What should I do?', iconName: 'info' },
    { route: 'security', label: 'Privacy & capability', iconName: 'lock' },
  ];
  return el('section', { class: 'card' },
    el('div', { class: 'section-title' }, 'Also here'),
    el('nav', { class: 'btn-row', 'aria-label': 'Other SheSafe features' },
      ...entries.map((entry) => el('a', { class: 'btn btn--quiet btn--block', href: `#/${entry.route}` },
        icon(entry.iconName), entry.label))));
}

/* -------------------------------------------------------------- emergency bar */

/** A shell-level indicator so an open incident is visible from every screen. */
export function renderEmergencyBar() {
  const host = $('#emergency-bar-host');
  if (!host) return;
  const { sosPhase, incident, cancelSecondsLeft } = store.get();

  if (sosPhase === 'COUNTDOWN') {
    mount(host, el('div', { class: 'emergency-bar emergency-bar--countdown', role: 'alert' },
      icon('clock'),
      el('span', {}, `Emergency activates in ${cancelSecondsLeft}s — reference ${incident?.reference || 'pending'}`),
      el('button', { class: 'emergency-bar__cta', type: 'button', onclick: () => void sos.cancelBeforeActivation() }, 'Cancel now')));
    return;
  }

  if (sosPhase === 'ACTIVATING') {
    mount(host, el('div', { class: 'emergency-bar emergency-bar--countdown', role: 'alert' },
      icon('clock'),
      el('span', {}, `Activating ${incident?.reference ? `· ${incident.reference}` : ''} — capturing your position`)));
    return;
  }

  if (['ACTIVE', 'ESCALATING'].includes(sosPhase) && incident) {
    mount(host, el('div', { class: 'emergency-bar', role: 'alert' },
      icon('siren'),
      el('span', {}, `SOS ${sosPhase === 'ESCALATING' ? 'ESCALATING' : 'ACTIVE'} · ${incident.reference}`),
      el('a', { class: 'emergency-bar__cta', href: '#/home' }, 'Open emergency')));
    return;
  }

  mount(host);
}

export function renderHeaderStatus() {
  const host = $('#header-status');
  if (!host) return;
  const { sosPhase, sharingActive } = store.get();
  const bits = [];
  if (['ACTIVE', 'ESCALATING'].includes(sosPhase)) bits.push(pill('SOS active', 'danger', { live: true }));
  if (sharingActive) bits.push(pill('Sharing', 'safe', { live: true }));
  mount(host, ...bits);
}

/* ------------------------------------------------------------- siren */

function onSirenToggle() {
  const on = sos.toggleSound();
  const button = $('#btn-siren-toggle');
  if (button) {
    mount(button, icon(on ? 'volume' : 'mute'), on ? 'Siren on' : 'Siren off');
    button.setAttribute('aria-pressed', String(on));
  }
}

/* ------------------------------------------------------------- render */

export function renderEmergency() {
  const host = $('#home-emergency');
  if (!host) return;
  queueMicrotask(helplineList);
  const { sosPhase, incident, cancelSecondsLeft } = store.get();

  if (sosPhase === 'COUNTDOWN') {
    mount(host, countdownConsole(incident, cancelSecondsLeft));
  } else if (sosPhase === 'ACTIVATING') {
    mount(host, activatingConsole(incident));
  } else if (['ACTIVE', 'ESCALATING'].includes(sosPhase) && incident) {
    mount(host, activeConsole(incident, { escalated: sosPhase === 'ESCALATING' }));
  } else if (store.get().lastOutcome) {
    mount(host, el('div', { class: 'card', dataset: { slot: 'outcome' } },
      el('div', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title' }, 'Last emergency'),
          el('p', { class: 'card__hint' }, `${store.get().lastOutcome.replace(/_/g, ' ').toLowerCase()} · reference ${incident?.reference || '—'}`)),
        pill(store.get().lastOutcome === 'RESOLVED_SAFE' ? 'Stood down safely' : 'Closed', store.get().lastOutcome === 'RESOLVED_SAFE' ? 'safe' : 'neutral')),
      el('p', { class: 'small' }, 'The full record, including what was and was not delivered, is in incident history.'),
      sosDock()));
  } else {
    mount(host, sosDock());
  }
}

export async function renderDashboard() {
  renderEmergency();
  renderHeaderStatus();
  renderEmergencyBar();

  mount($('#home-safety'), safetyStatusPanel());
  mount($('#home-detail'),
    journeyStrip(),
    locationStrip(),
    contactsStrip(),
    placesStrip(placeCache),
    intelligenceStrip());
  mount($('#home-secondary'), secondaryStrip());
}

let placeCache = null;

export function cachePlaces(list) {
  placeCache = (list || []).slice(0, 3);
}

export async function refreshDashboardData() {
  await Promise.allSettled([
    intelligence.loadAssessment({ silent: true }),
    journey.loadJourney({ silent: true }),
    contacts.loadContacts({ silent: true }),
    places.loadNearbyPlaces({ limit: 3 }).then((response) => cachePlaces(response && response.places)),
    sharing.refreshLatest(),
  ]);
  renderDashboard();
}
