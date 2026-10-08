/**
 * Community reports + moderation, and the incident-assist (AI) screen.
 */

import { api } from '../core/api.js';
import { el, errorState, formatTime, mount, notice, skeletonList } from '../core/dom.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

const STATE_BADGE = {
  COMMUNITY_REPORTED: { badge: 'badge--warn', label: 'Community reported' },
  UNDER_REVIEW: { badge: 'badge--info', label: 'Under review' },
  VERIFIED: { badge: 'badge--safe', label: 'Verified' },
  DISMISSED: { badge: 'badge--muted', label: 'Dismissed' },
  RESOLVED: { badge: 'badge--muted', label: 'Resolved' },
};

const CATEGORIES = ['unsafe_area', 'harassment', 'eve_teasing', 'stalking', 'theft', 'assault', 'medical', 'accident', 'domestic_violence', 'other'];
const SEVERITIES = ['low', 'moderate', 'high', 'critical'];

export async function loadReports({ silent = false } = {}) {
  const target = document.getElementById('reports-feed');
  if (!target) return [];
  if (!silent) mount(target, skeletonList(3));

  const location = store.get().location;
  try {
    const params = location ? { lat: location.lat, lng: location.lng, radiusKm: 6 } : null;
    const response = await api.reports(params);
    renderReports(target, response);
    return response.reports || [];
  } catch (error) {
    mount(target, errorState(error.message, () => loadReports()));
    return [];
  }
}

function renderReports(target, response) {
  const reports = response.reports || [];
  if (!reports.length) {
    mount(
      target,
      notice('info', 'Nothing reported near you yet', 'Reports are added by users. SheSafe never fabricates community activity, so an empty feed is the honest result.'),
    );
    return;
  }
  mount(
    target,
    el('ul', { class: 'list' }, ...reports.map(reportItem)),
    el('details', { style: { marginTop: '16px' } },
      el('summary', { class: 'tiny', style: { cursor: 'pointer', fontWeight: '700' } }, 'What these labels mean'),
      el('dl', { class: 'kv', style: { marginTop: '8px' } },
        ...Object.entries(response.stateLegend || {}).flatMap(([state, text]) => [
          el('dt', {}, STATE_BADGE[state]?.label || state),
          el('dd', { class: 'tiny' }, text),
        ]),
      ),
    ),
  );
}

function reportItem(report) {
  const meta = STATE_BADGE[report.state] || { badge: 'badge--muted', label: report.state };
  return el(
    'li',
    { class: 'list__item' },
    el('div', { class: 'list__icon', 'aria-hidden': 'true' }, report.category === 'unsafe_area' ? '⚠️' : '📍'),
    el(
      'div',
      { class: 'list__body' },
      el('div', { class: 'row', style: { gap: '6px' } },
        el('span', { class: `badge ${meta.badge}` }, meta.label),
        report.anonymous ? el('span', { class: 'badge badge--muted' }, 'Anonymous') : null,
        report.distanceKm != null ? el('span', { class: 'badge badge--muted' }, `${report.distanceKm.toFixed(1)} km`) : null,
      ),
      el('div', { class: 'list__title', style: { marginTop: '4px' } }, report.title),
      report.description ? el('p', { class: 'tiny' }, report.description) : null,
      el('div', { class: 'list__meta' }, `${report.placeLabel || 'Location not recorded'} · ${formatTime(report.createdAt)} · ${report.helpfulCount} found this helpful`),
      report.moderatorNote ? el('p', { class: 'tiny', style: { marginTop: '4px' } }, `Moderator: ${report.moderatorNote}`) : null,
    ),
    el(
      'div',
      { class: 'list__actions' },
      el('button', { class: 'btn btn--quiet', type: 'button', onclick: (e) => helpful(report.id, e.currentTarget) }, 'Helpful'),
      el('button', { class: 'btn btn--quiet', type: 'button', onclick: () => moderatePrompt(report) }, 'Review'),
    ),
  );
}

async function helpful(id, button) {
  try {
    const response = await api.helpfulReport(id);
    button.textContent = `Helpful (${response.helpfulCount})`;
    button.disabled = true;
  } catch (error) {
    toast(error.message, 'warning');
  }
}

function moderatePrompt(report) {
  const note = window.prompt(`Moderating: "${report.title}"\nAdd a note explaining your decision (required to verify):`);
  if (note === null) return;
  const nextState = window.confirm('Is this report VERIFIED?\n\nOK = VERIFIED\nCancel = move to UNDER_REVIEW');
  const state = nextState ? 'VERIFIED' : 'UNDER_REVIEW';
  const confidence = nextState ? window.prompt('Confidence 0.5-1.0 (verification requires >= 0.5):', '0.7') : '0.3';
  if (confidence === null) return;
  void api
    .moderateReport(report.id, { state, note: note.trim(), confidence: Number(confidence) })
    .then(() => {
      toast(`Report moved to ${state.replace(/_/g, ' ').toLowerCase()}.`, 'success');
      return loadReports({ silent: true });
    })
    .catch((error) => toast(error.message, 'error'));
}

/** Build the report submission form. */
export function reportForm() {
  const form = el('form', { id: 'report-form' });
  const title = el('input', { class: 'input', id: 'report-title', required: true, maxlength: '120', placeholder: 'Short headline' });
  const category = el('select', { class: 'select', id: 'report-category' }, ...CATEGORIES.map((c) => el('option', { value: c }, c.replace(/_/g, ' '))));
  const severity = el('select', { class: 'select', id: 'report-severity' }, ...SEVERITIES.map((s) => el('option', { value: s, selected: s === 'moderate' }, s)));
  const description = el('textarea', { class: 'textarea', id: 'report-description', maxlength: '2000', placeholder: 'What happened, and anything that helps others.' });
  const anonymous = el('input', { type: 'checkbox', id: 'report-anonymous' });
  const attachLocation = el('input', { type: 'checkbox', id: 'report-attach-location', checked: true });

  form.append(
    el('div', { class: 'stack' },
      el('div', { class: 'field' }, el('label', { for: 'report-title' }, 'Headline'), title),
      el('div', { class: 'field' }, el('label', { for: 'report-category' }, 'Category'), category),
      el('div', { class: 'field' }, el('label', { for: 'report-severity' }, 'Severity'), severity),
      el('div', { class: 'field' }, el('label', { for: 'report-description' }, 'Details'), description),
      el('label', { class: 'checkbox', for: 'report-attach-location' }, attachLocation, 'Attach my current position'),
      el('label', { class: 'checkbox', for: 'report-anonymous' }, anonymous, 'Post anonymously'),
      notice('info', 'Community reports are not facts', 'Your submission is stored as COMMUNITY_REPORTED. It only becomes VERIFIED after an explicit review with a written reason.'),
      el('button', { class: 'btn btn--brand btn--block', type: 'submit' }, 'Submit report'),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const location = store.get().location;
    try {
      const response = await api.createReport({
        title: title.value.trim(),
        category: category.value,
        severity: severity.value,
        description: description.value.trim(),
        anonymous: anonymous.checked,
        lat: attachLocation.checked && location ? location.lat : null,
        lng: attachLocation.checked && location ? location.lng : null,
        placeLabel: location ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : null,
      });
      toast(response.notice, 'success', { timeout: 7000 });
      form.reset();
      document.getElementById('report-modal')?.close();
      await loadReports({ silent: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  return form;
}

/* ------------------------------------------------------- incident assist */

export async function runIncidentAssist(description) {
  const target = document.getElementById('assist-result');
  if (!target) return;
  mount(target, skeletonList(2));
  try {
    const response = await api.incidentAssist(description);
    const assist = response.assist;
    mount(
      target,
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'row row--between' },
          el('h3', { class: 'card__title' }, `${assist.categoryLabel} · ${assist.severity}`),
          el('span', { class: `badge ${assist.source === 'llm' ? 'badge--violet' : 'badge--info'}` }, assist.source === 'llm' ? 'AI suggestion' : 'Rule-based'),
        ),
        el('p', { class: 'card__hint' }, `${assist.reason} Confidence ${Math.round(assist.confidence * 100)}%.`),
        el('h4', { style: { marginTop: '14px' } }, 'Recommended actions'),
        el('ol', { style: { marginTop: '6px', paddingLeft: '1.1rem' } },
          ...(assist.recommendedActions || []).map((action) => el('li', { class: 'tiny' }, action)),
        ),
        el('h4', { style: { marginTop: '14px' } }, 'Quick actions'),
        el('div', { class: 'stack stack--tight', style: { marginTop: '6px' } },
          ...(assist.quickActions || []).map((action) =>
            el('div', {},
              el('div', { style: { fontWeight: '700', fontSize: '0.9rem' } }, action.label),
              el('div', { class: 'tiny' }, action.hint),
            ),
          ),
        ),
        el('div', { class: 'row', style: { gap: '8px', marginTop: '16px' } },
          el('a', { class: 'btn btn--danger', href: 'tel:112' }, 'Call 112'),
          el('button', { class: 'btn btn--brand', type: 'button', onclick: () => { window.location.hash = '#/home'; document.getElementById('btn-sos')?.focus(); } }, 'Open SOS'),
        ),
        el('p', { class: 'tiny', style: { marginTop: '10px' } }, assist.disclaimer),
        el('p', { class: 'tiny' }, assist.aiNote),
      ),
    );
  } catch (error) {
    mount(target, errorState(error.message, null), notice('info', 'Guidance unavailable', 'The classifier could not be reached. This does not affect SOS - press SOS or call 112.'));
  }
}