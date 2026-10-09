/**
 * Community reports and moderation, plus the advisory incident classifier.
 *
 * Two rules this module enforces visually:
 *
 * 1. **A community report is never presented as fact.** Every row carries its
 *    moderation state as a word, and the legend is on the same screen.
 * 2. **Moderation is an explicit, auditable action.** Choosing the next state is
 *    one tap, but a written reason is required before anything can reach
 *    VERIFIED, and the permission model is stated rather than implied.
 */

import { api } from '../core/api.js';
import { el, mount } from '../core/dom.js';
import {
  actionSheet, card, dataList, dataRow, disclosure, icon, loadInto,
  notice, openSheet, pill, promptSheet,
} from '../core/ui.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

const STATE_META = {
  COMMUNITY_REPORTED: { label: 'COMMUNITY REPORTED', tone: 'caution', hint: 'Submitted by a user. Not verified. Treat as a lead, not a fact.' },
  UNDER_REVIEW: { label: 'UNDER REVIEW', tone: 'info', hint: 'A moderator is reviewing this report.' },
  VERIFIED: { label: 'VERIFIED', tone: 'safe', hint: 'Corroborated by a moderator with a written reason.' },
  DISMISSED: { label: 'DISMISSED', tone: 'neutral', hint: 'Reviewed and found unsupported.' },
  RESOLVED: { label: 'RESOLVED', tone: 'neutral', hint: 'Actioned and closed.' },
};

const CATEGORIES = [
  ['unsafe_area', 'Unsafe area'], ['harassment', 'Harassment'], ['eve_teasing', 'Eve teasing'],
  ['stalking', 'Stalking'], ['theft', 'Theft'], ['assault', 'Assault'], ['medical', 'Medical'],
  ['accident', 'Accident'], ['domestic_violence', 'Domestic violence'], ['other', 'Other'],
];
const SEVERITIES = [['low', 'Low'], ['moderate', 'Moderate'], ['high', 'High'], ['critical', 'Critical']];

export const reportStateMeta = (state) => STATE_META[state] || { label: state, tone: 'neutral', hint: '' };

/* ------------------------------------------------------------------ feed */

export async function loadReports({ silent = false } = {}) {
  const target = document.getElementById('reports-feed');
  const actions = document.getElementById('reports-actions');

  mount(actions, el('div', { class: 'btn-row' },
    el('button', { class: 'btn btn--primary btn--block', type: 'button', 'data-open-modal': 'sheet-report' }, icon('plus'), 'Report an incident'),
    el('a', { class: 'btn btn--quiet btn--block', href: '#/intelligence' }, icon('gauge'), 'See how reports affect the score')));

  if (!target) return [];
  if (silent) return [];

  await loadInto(target, async () => {
    const location = store.get().location;
    const params = location ? { lat: location.lat, lng: location.lng, radiusKm: 6 } : null;
    const response = await api.reports(params);
    renderReports(target, response);
    return response.reports || [];
  }, { rows: 3 });
}

function renderReports(target, response) {
  const reports = response.reports || [];
  if (!reports.length) {
    mount(target, card('Nothing reported near you', {
      body: [notice('info', 'An empty feed is the honest result',
        'Reports are added by users. SheSafe never fabricates community activity, so an empty feed means nobody has reported anything here — not that the area is safe.')],
    }));
    return;
  }

  mount(target,
    card('Nearby reports', {
      hint: 'Always labelled by moderation state. Distance is measured from your position.',
      action: pill(`${reports.length} shown`, 'neutral'),
      body: [dataList(reports.map(reportItem))],
    }),
    card('What these labels mean', {
      body: [dataList(Object.entries(STATE_META).map(([key, meta]) =>
        dataRow({
          iconName: meta.tone === 'safe' ? 'checkCircle' : meta.tone === 'caution' ? 'alert' : 'info',
          title: meta.label,
          badges: [pill(meta.label, meta.tone)],
          meta: meta.hint,
        })))],
    }),
    notice('info', 'How reports reach the safety score',
      'A community report is weighted by its moderation state: an unverified report can move the risk score, but never far, and never as a confirmed fact.'));
}

function reportItem(report) {
  const meta = reportStateMeta(report.state);
  return dataRow({
    iconName: report.category === 'unsafe_area' ? 'alert' : 'pin',
    title: report.title,
    badges: [
      pill(meta.label, meta.tone),
      report.anonymous ? pill('Anonymous', 'neutral') : null,
      report.distanceKm != null ? pill(`${report.distanceKm.toFixed(1)} km`, 'neutral') : null,
      report.reportCount > 1 ? pill(`×${report.reportCount}`, 'info') : null,
    ],
    meta: [
      CATEGORIES.find(([id]) => id === report.category)?.[1] || report.category,
      report.severity ? `${report.severity} severity` : null,
      report.placeLabel || 'Location not recorded',
      report.createdAt ? new Date(report.createdAt).toLocaleString() : null,
      `${report.helpfulCount} found this helpful`,
    ].filter(Boolean).join(' · '),
    body: el('div', { class: 'stack stack--tight' },
      report.description ? el('p', { class: 'small' }, report.description) : null,
      report.moderatorNote ? el('p', { class: 'small' }, `Moderator: ${report.moderatorNote}`) : null,
      disclosure(meta.hint, el('p', { class: 'small' }, 'A report is a lead. Only a moderator with a written reason can move it to VERIFIED, and SheSafe never presents a community report as a confirmed statistic.'))),
    actions: [
      el('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: (event) => helpful(report.id, event.currentTarget) }, icon('checkCircle'), 'Helpful'),
      el('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => void moderatePrompt(report) }, icon('eye'), 'Review'),
    ],
  });
}

async function helpful(id, button) {
  try {
    const response = await api.helpfulReport(id);
    button.disabled = true;
    button.textContent = `Helpful (${response.helpfulCount})`;
    toast(response.counted ? 'Marked as helpful.' : 'You have already marked this report as helpful.', 'info');
  } catch (error) {
    toast(error.message, 'warning');
  }
}

/* ------------------------------------------------------------ moderation */

/**
 * One sheet, explicit states, required written reason.
 *
 * The previous flow was three chained native dialogs where the chosen button
 * silently decided the state. Choosing a state here also states its
 * consequence, and the reason is captured before the request is sent.
 */
async function moderatePrompt(report) {
  const choice = await actionSheet({
    title: `Moderate "${report.title}"`,
    body: `Currently ${reportStateMeta(report.state).label}. Only a moderator with a written reason can move a report to VERIFIED.`,
    options: [
      { id: 'UNDER_REVIEW', label: 'Move to UNDER REVIEW', hint: 'Claim it for review. Visible to other readers as unreviewed.', iconName: 'eye' },
      { id: 'VERIFIED', label: 'Verify as corroborated', hint: 'Requires a written reason and a confidence of at least 0.5. Raises its weight in the safety score.', iconName: 'checkCircle' },
      { id: 'DISMISSED', label: 'Dismiss as unsupported', hint: 'Removes it from the public feed. The record is kept.', iconName: 'x' },
      { id: 'RESOLVED', label: 'Mark as resolved', hint: 'Actioned and closed.', iconName: 'archive' },
    ],
  });
  if (!choice) return;

  const needsReason = ['VERIFIED', 'DISMISSED', 'RESOLVED'].includes(choice);
  let note = '';
  if (needsReason) {
    const entered = await promptSheet({
      title: 'Reason for this decision',
      body: choice === 'VERIFIED'
        ? 'This reason is shown to anyone reading the report, and is the audit record for the verification.'
        : 'A short reason is stored with the report.',
      label: 'Written reason',
      hint: choice === 'VERIFIED' ? 'Required. Example: two independent reports plus a review of nearby CCTV.' : 'Required before the state can be saved.',
      maxLength: 500,
    });
    if (entered === null) return;
    note = entered;
  }

  const confidence = choice === 'VERIFIED' ? await askConfidence() : 0;
  if (confidence === null) return;

  try {
    const response = await api.moderateReport(report.id, { state: choice, note, confidence });
    toast(`Report moved to ${reportStateMeta(choice).label.toLowerCase()}.`, 'success');
    if (response.note) toast(response.note, 'info', { timeout: 8000 });
    await loadReports();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function askConfidence() {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'sheet', 'aria-label': 'Moderator confidence' });
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(value); };
    const input = el('input', { class: 'input', id: 'moderation-confidence', type: 'number', min: '0.5', max: '1', step: '0.05', value: '0.7', inputmode: 'decimal' });

    dialog.appendChild(el('form', { class: 'sheet__panel', onsubmit: (event) => {
      event.preventDefault();
      const value = Number(input.value);
      if (!(value >= 0.5 && value <= 1)) { toast('Confidence must be between 0.5 and 1.', 'warning'); return; }
      finish(value);
    } },
      el('div', { class: 'sheet__grabber', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet__head' },
        el('h2', {}, 'How confident are you?'),
        el('button', { class: 'sheet__close', type: 'button', 'aria-label': 'Close', onclick: () => finish(null) }, icon('x'))),
      el('div', { class: 'stack' },
        el('div', { class: 'field' },
          el('label', { for: 'moderation-confidence' }, 'Confidence, 0.5 to 1.0'),
          input,
          el('span', { class: 'field__hint' }, 'Verification is refused below 0.5. This value scales how much the report moves the safety score.')),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn btn--quiet btn--block', type: 'button', onclick: () => finish(null) }, 'Cancel'),
          el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Verify report')))));
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(null); });
    openSheet(dialog);
    input.focus();
  });
}

/* ------------------------------------------------------------ submit form */

export function reportForm() {
  const form = el('form', { id: 'report-form' });

  const title = el('input', { class: 'input', id: 'report-title', required: true, maxlength: '120', placeholder: 'Short headline' });
  const category = el('select', { class: 'select', id: 'report-category' },
    ...CATEGORIES.map(([value, label]) => el('option', { value }, label)));
  const severity = el('select', { class: 'select', id: 'report-severity' },
    ...SEVERITIES.map(([value, label]) => el('option', { value, selected: value === 'moderate' }, label)));
  const description = el('textarea', { class: 'textarea', id: 'report-description', maxlength: '2000', placeholder: 'What happened, and anything that helps others.' });
  const anonymous = el('input', { type: 'checkbox', id: 'report-anonymous' });
  const attachLocation = el('input', { type: 'checkbox', id: 'report-attach-location', checked: true });

  form.append(el('div', { class: 'stack' },
    el('div', { class: 'field' }, el('label', { for: 'report-title' }, 'Headline'), title),
    el('div', { class: 'grid grid--2' },
      el('div', { class: 'field' }, el('label', { for: 'report-category' }, 'Category'), category),
      el('div', { class: 'field' }, el('label', { for: 'report-severity' }, 'Severity'), severity)),
    el('div', { class: 'field' }, el('label', { for: 'report-description' }, 'Details'), description),
    el('label', { class: 'checkbox', for: 'report-attach-location' }, attachLocation, 'Attach my current position'),
    el('label', { class: 'checkbox', for: 'report-anonymous' }, anonymous, 'Post anonymously'),
    notice('caution', 'A community report is not a fact',
      'Your submission is stored as COMMUNITY REPORTED. It only becomes VERIFIED after an explicit review with a written reason.'),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, icon('plus'), 'Submit report')));

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
      toast(response.notice, 'success', { timeout: 8000 });
      form.reset();
      document.getElementById('sheet-report')?.close();
      await loadReports();
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
  await loadInto(target, async () => {
    const response = await api.incidentAssist(description);
    const assist = response.assist;
    mount(target,
      card(`${assist.categoryLabel} · ${assist.severity}`, {
        hint: `${assist.reason} Confidence ${Math.round(assist.confidence * 100)}%.`,
        action: pill(assist.source === 'llm' ? 'AI suggestion' : 'Rule-based', assist.source === 'llm' ? 'brand' : 'info'),
        body: [
          el('div', { class: 'section-title' }, 'Recommended actions'),
          el('ol', { class: 'stack stack--tight plain-list numbered' },
            ...(assist.recommendedActions || []).map((action, index) =>
              el('li', { class: 'row row--tight' },
                el('span', { class: 'demo-step__n', 'aria-hidden': 'true' }, String(index + 1)),
                el('span', { class: 'small grow' }, action)))),
          el('div', { class: 'section-title' }, 'Quick actions'),
          el('ul', { class: 'plain-list stack stack--tight' },
            ...(assist.quickActions || []).map((action) =>
              el('li', { class: 'small' }, el('strong', {}, action.label), ' — ', action.hint))),
          el('div', { class: 'btn-row' },
            el('a', { class: 'btn btn--danger btn--block', href: 'tel:112' }, icon('phone'), 'Call 112'),
            el('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: () => { window.location.hash = '#/home'; } }, icon('siren'), 'Open SOS')),
          el('p', { class: 'small' }, assist.disclaimer),
          el('p', { class: 'small' }, assist.aiNote),
        ],
      }),
      notice('info', 'This can never raise an alert', 'The classifier is advisory. It has no code path to SOS and no ability to delay one.'));
    return assist;
  }, { rows: 2, tall: true });
}
