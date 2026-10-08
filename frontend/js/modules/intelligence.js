/**
 * Safety Intelligence view: point risk assessment with full explainability.
 *
 * The screen's job is to make the score auditable - weights, per-feature
 * contribution, confidence, provenance and the engine's own limitations. A judge
 * should be able to check the arithmetic on screen.
 */

import { api } from '../core/api.js';
import { el, errorState, mount, notice, skeletonList } from '../core/dom.js';
import { store } from '../core/store.js';

const BAND_CLASS = { LOW: 'badge--safe', MODERATE: 'badge--warn', HIGH: 'badge--warn', CRITICAL: 'badge--danger' };
const BAND_HINT = {
  LOW: 'No strong risk signals for this place and time.',
  MODERATE: 'Some risk signals present. Stay aware.',
  HIGH: 'Several risk signals present. Prefer main roads and lit areas.',
  CRITICAL: 'Multiple strong risk signals. Avoid being here alone if you can.',
};

export async function renderAssessment() {
  const target = document.getElementById('assessment-panel');
  if (!target) return;
  mount(target, skeletonList(3));

  try {
    const response = await api.assess();
    renderAssessmentPanel(target, response.assessment, response.location);
  } catch (error) {
    mount(
      target,
      errorState(error.message, () => renderAssessment()),
      el('p', { class: 'tiny' }, 'A point assessment needs a position. Enable location, or open this screen again once GPS has a fix.'),
    );
  }
}

export function renderAssessmentPanel(target, assessment, position) {
  const features = assessment.features || [];

  mount(
    target,
    el(
      'div',
      { class: 'card' },

      el(
        'div',
        { class: 'card__head' },
        el(
          'div',
          {},
          el('h3', { class: 'card__title' }, 'Safety score'),
          el(
            'p',
            { class: 'card__hint' },
            `${assessment.band} risk · confidence ${Math.round(assessment.confidence * 100)}% · ${assessment.confidenceLabel}`,
          ),
        ),
        el('span', { class: `badge ${BAND_CLASS[assessment.band] || 'badge--muted'}` }, assessment.band),
      ),

      el(
        'div',
        { class: 'row', style: { alignItems: 'baseline', gap: '10px' } },
        el('span', { style: { fontSize: '3rem', fontWeight: '800', lineHeight: '1' } }, String(assessment.riskScore)),
        el('span', { class: 'tiny' }, '/ 100 risk'),
        el('span', { class: 'push badge badge--muted' }, `safety ${assessment.safetyScore}`),
      ),
      riskMeter(assessment.riskScore),

      el('p', { class: 'tiny', style: { marginTop: '10px' } }, BAND_HINT[assessment.band] || ''),

      position
        ? el('p', { class: 'mono tiny', style: { marginTop: '6px' } }, `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`)
        : null,

      (assessment.drivers || []).length
        ? el(
            'div',
            { style: { marginTop: '16px' } },
            el('h4', {}, 'What is driving this score'),
            el('ul', { class: 'stack stack--tight', style: { listStyle: 'none', padding: '0', marginTop: '8px' } },
              ...assessment.drivers.map((reason) =>
                el('li', { class: 'row', style: { gap: '8px', alignItems: 'flex-start' } },
                  el('span', { 'aria-hidden': 'true' }, '•'),
                  el('span', {}, reason),
                ),
              ),
            ),
          )
        : null,

      (assessment.protectiveFactors || []).length
        ? el(
            'div',
            { style: { marginTop: '12px' } },
            el('h4', {}, 'What is working in your favour'),
            el('ul', { style: { listStyle: 'none', padding: '0', marginTop: '6px', color: 'var(--safe-700)', fontSize: '0.88rem' } },
              ...assessment.protectiveFactors.map((text) => el('li', {}, `✓ ${text}`)),
            ),
          )
        : null,
    ),

    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card__head' },
        el(
          'div',
          {},
          el('h3', { class: 'card__title' }, 'Feature weighting'),
          el('p', { class: 'card__hint' }, 'Points contributed to the score. Weights total 100.'),
        ),
      ),
      ...features.map(featureRow),
    ),

    el(
      'div',
      { class: 'card' },
      el('h3', { class: 'card__title', style: { marginBottom: '10px' } }, 'How to read this'),
      notice('info', 'This is a rule set, not a trained model',
        'SheSafe scores risk with transparent weighted rules. No machine-learning model has been trained on crime data, so no accuracy figure is claimed anywhere in this product.'),
      el('div', { class: 'stack stack--tight', style: { marginTop: '12px' } },
        ...(assessment.caveats || []).map((caveat) =>
          el('p', { class: 'tiny' }, `• ${caveat}`),
        ),
      ),
      el(
        'details',
        { style: { marginTop: '12px' } },
        el('summary', { class: 'tiny', style: { cursor: 'pointer', fontWeight: '700' } }, 'Data provenance'),
        el(
          'ul',
          { style: { listStyle: 'none', padding: '0', marginTop: '8px' } },
          ...(assessment.provenance || []).map((entry) =>
            el('li', { class: 'mono tiny' }, `${entry.feature}: ${entry.source}${entry.observed ? '' : ' (not observed)'}`),
          ),
        ),
      ),
    ),
  );
}

function riskMeter(score) {
  const meter = el('div', { class: 'risk', style: { '--risk': String(score) } });
  meter.appendChild(el('span', { class: 'risk__marker' }));
  return el(
    'div',
    { style: { marginTop: '12px' } },
    meter,
    el(
      'div',
      { class: 'risk-scale' },
      el('span', {}, '0 low'),
      el('span', {}, '31 moderate'),
      el('span', {}, '61 high'),
      el('span', {}, '81 critical'),
    ),
  );
}

function featureRow(feature) {
  return el(
    'div',
    { class: 'feature-row' },
    el('span', { class: 'feature-row__label' }, feature.label),
    el('span', { class: 'feature-row__points' }, `${feature.points} / ${feature.weight}`),
    el('span', { class: 'feature-row__reason' }, feature.reason),
    feature.detail ? el('span', { class: 'feature-row__detail' }, feature.detail) : null,
    el('span', { class: 'feature-row__provenance' }, `${feature.provenance}${feature.observed ? ` · n=${feature.observations}` : ''}`),
  );
}

export async function loadEngineInfo() {
  try {
    const response = await api.explain();
    const target = document.getElementById('engine-info');
    if (!target) return;
    mount(
      target,
      el('p', { class: 'tiny' }, `Engine: ${response.engine.model}`),
      el('p', { class: 'tiny' }, response.engine.scoreSemantics),
      el(
        'ul',
        { style: { listStyle: 'none', padding: '0', marginTop: '8px' } },
        ...response.engine.limitations.map((limit) => el('li', { class: 'tiny' }, `• ${limit}`)),
      ),
    );
  } catch {
    /* informational only */
  }
}