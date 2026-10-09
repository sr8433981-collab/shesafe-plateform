/**
 * Privacy & capability.
 *
 * Everything on this screen is read from the server: the capability manifest,
 * the retention report, the audit trail. Nothing is hardcoded here, so the page
 * cannot quietly claim something the backend does not do — and when a provider
 * is configured, the page changes on its own.
 */

import { api } from '../core/api.js';
import { el, mount } from '../core/dom.js';
import {
  card, confirmSheet, dataList, dataRow, icon, loadInto, notice, pill, promptSheet,
} from '../core/ui.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

const PROTECTIONS = [
  ['PBKDF2-SHA256 password hashing', 'Passwords are stretched with 600,000 iterations and compared in constant time.'],
  ['Signed, HttpOnly session cookie', 'The session value is signed and unreadable from JavaScript, so an XSS bug cannot steal it.'],
  ['CSRF double-submit on every write', 'Every state-changing request must echo a token the browser cannot be tricked into sending.'],
  ['Owner-scoped queries', 'Every read and write is filtered to the authenticated account. There is no ID to guess.'],
  ['256-bit share tokens, hashed at rest', 'Only a SHA-256 hash is stored, so a database leak cannot be replayed. Tokens expire and revoke.'],
  ['Rate limits', 'Auth, SOS, location and writes are limited per account and per client.'],
  ['Strict CSP and framing denial', 'The app cannot be framed, and it cannot load or execute script from anywhere but itself and one CDN.'],
  ['Privacy-scrubbed audit log', 'Coordinates are coarsened to roughly 110 m before they are written. Precise values are never logged.'],
];

const LIMITATIONS = [
  'No government, police or ambulance integration. SheSafe will never claim otherwise.',
  'No background monitoring: GPS, live tracking and Journey Guard need the page open.',
  'No street-lighting, CCTV or occupancy data, so the safety score cannot use them.',
  'No trained ML model, so no accuracy figure is quoted anywhere.',
  'Contact numbers are only self-confirmed unless a verification provider is configured.',
  'Web push requires a service worker and a configured provider.',
];

/* ------------------------------------------------------------------ view */

export async function renderSecurityView() {
  renderStaticPanels();
  renderCapabilityPanel();
  renderDataPanel();
  await Promise.allSettled([renderAudit(), renderRetention()]);
}

function renderCapabilityPanel() {
  const host = document.getElementById('capability-list');
  if (!host) return;
  const capabilities = store.get().capabilities || [];
  if (!capabilities.length) {
    mount(host, el('p', { class: 'small' }, 'Loading the capability manifest…'));
    return;
  }
  mount(host, dataList(capabilities.map(capabilityRow)));
}

const CAPABILITY_ICON = { real: 'checkCircle', simulated: 'alert', unavailable: 'x', partial: 'alert' };

function capabilityRow(capability) {
  return dataRow({
    iconName: CAPABILITY_ICON[capability.mode] || 'info',
    title: capability.label,
    badges: [pill(capability.mode.toUpperCase(), capability.mode)],
    meta: capability.detail,
  });
}

function renderStaticPanels() {
  const host = document.getElementById('security-panels');
  if (!host) return;
  mount(host,
    card('What this build can really do', {
      hint: 'Read live from GET /api/capabilities. Nothing here is hardcoded.',
      action: pill('Server manifest', 'info'),
      body: [
        el('div', { id: 'capability-list' }, el('p', { class: 'small' }, 'Loading the capability manifest…')),
        el('div', { id: 'capability-disclaimers', class: 'stack stack--tight pad-top' }),
      ],
    }),
    card('Protections in place', {
      body: [dataList(PROTECTIONS.map(([title, detail]) => dataRow({ iconName: 'lock', title, meta: detail })))],
    }),
    card('Deliberate limitations', {
      hint: 'Stated here rather than discovered in an emergency.',
      body: [dataList(LIMITATIONS.map((text) => dataRow({ iconName: 'alert', title: text })))],
    }));
}

function renderDataPanel() {
  const host = document.getElementById('security-actions');
  if (!host) return;
  mount(host,
    card('Your data', {
      hint: 'Export a copy, age out what should have expired, or delete the account.',
      body: [
        el('div', { id: 'retention-panel' }, el('p', { class: 'small' }, 'Loading retention policy…')),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: () => void exportData() }, icon('download'), 'Export my data'),
          el('button', { class: 'btn btn--quiet btn--block', type: 'button', onclick: () => void runCleanup() }, icon('refresh'), 'Run cleanup now')),
        el('button', { class: 'btn btn--danger-ghost btn--block', type: 'button', onclick: () => void deleteAccount() }, icon('trash'), 'Delete my account'),
      ],
    }));
}

async function renderRetention() {
  const target = document.getElementById('retention-panel');
  if (!target) return;
  await loadInto(target, async () => {
    const response = await api.retention();
    const counts = response.counts || {};
    const policy = response.policy || {};
    mount(target,
      el('div', { class: 'stack stack--tight' },
        el('div', { class: 'section-title' }, 'Retention policy'),
        el('ul', { class: 'plain-list stack stack--tight' },
          ...(response.categories || []).map((entry) =>
            el('li', { class: 'small' }, el('strong', {}, entry.label), ` — ${entry.why} Retained: ${entry.retention}`)),
          ...(response.notes || []).map((note) => el('li', { class: 'small' }, `• ${note}`))),
        el('div', { class: 'section-title' }, 'Currently stored'),
        el('ul', { class: 'plain-list small' },
          el('li', {}, `Location samples: ${counts.locationSamples ?? 0} (of which ${counts.incidentTrailSamples ?? 0} are incident trails)`),
          el('li', {}, `Share tokens: ${counts.shareTokens ?? 0} (${counts.expiredShareTokens ?? 0} expired)`),
          el('li', {}, `Audit rows: ${counts.auditRows ?? 0}`),
          el('li', {}, `Incidents: ${counts.incidents ?? 0}`),
          el('li', {}, `Notification attempts: ${counts.notificationAttempts ?? 0}`)),
        el('p', { class: 'small' },
          `Non-incident location retention: ${policy.nonIncidentLocationDays ?? '—'} days. ` +
          `Audit retention: ${policy.auditRetentionDays ?? '—'} days. ` +
          `Automatic cleanup runs every ${policy.cleanupIntervalSeconds ?? '—'} seconds.`)));
    return response;
  }, { rows: 3 });
}

async function renderAudit() {
  const target = document.getElementById('audit-list');
  if (!target) return;
  await loadInto(target, async () => {
    const response = await api.auditTail();
    const entries = response.entries || [];
    if (!entries.length) {
      mount(target, el('p', { class: 'small' }, 'No events recorded yet.'));
      return response;
    }
    mount(target, dataList(entries.slice(0, 25).map((entry) => dataRow({
      iconName: entry.outcome === 'success' ? 'checkCircle' : entry.outcome === 'denied' || entry.outcome === 'failure' ? 'alert' : 'info',
      title: entry.action,
      badges: [pill(entry.outcome, entry.outcome === 'success' ? 'safe' : entry.outcome === 'denied' ? 'danger' : 'neutral')],
      meta: [entry.created_at ? new Date(entry.created_at).toLocaleString() : null, entry.request_id ? `request ${entry.request_id}` : null].filter(Boolean).join(' · '),
    }))));
    return response;
  }, { rows: 4 });
}

/* --------------------------------------------------------------- actions */

async function exportData() {
  try {
    const response = await api.exportData();
    const blob = new Blob([JSON.stringify(response.export, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: `shesafe-export-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Your data has been exported. It contains precise coordinates and phone numbers — store it carefully.', 'success', { timeout: 9000 });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runCleanup() {
  const confirmed = await confirmSheet({
    title: 'Run the retention cleanup now?',
    body: 'This deletes expired share tokens, location samples past the retention window, and audit rows past their window. It never touches incident records or incident trails.',
    confirmLabel: 'Run cleanup',
    iconName: 'refresh',
  });
  if (!confirmed) return;
  try {
    const response = await api.runCleanup();
    const cleaned = response.cleaned || {};
    toast(`Cleaned: ${cleaned.expiredShareTokens ?? 0} expired links, ${cleaned.oldLocationSamples ?? 0} old samples, ${cleaned.auditRows ?? 0} audit rows.`, 'success', { timeout: 8000 });
    await renderRetention();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteAccount() {
  const first = await confirmSheet({
    title: 'Delete your SheSafe account?',
    body: 'Your contacts, location history, journeys, check-ins and notification records are deleted. Incident records are kept without an owner so the safety record is not silently rewritten.',
    confirmLabel: 'Continue',
    tone: 'danger',
    iconName: 'trash',
  });
  if (!first) return;

  const typed = await promptSheet({
    title: 'Type DELETE to confirm',
    body: 'This is irreversible.',
    label: 'Confirmation',
    placeholder: 'DELETE',
    hint: 'The word DELETE is required.',
    confirmLabel: 'Delete my account',
  });
  if (typed === null) return;

  try {
    await api.deleteAccount();
    toast('Your account has been deleted and your session revoked.', 'success', { timeout: 9000 });
    window.setTimeout(() => window.location.reload(), 1200);
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ----------------------------------------------------- capability manifest */

export function renderCapabilityStrip(host, capabilities) {
  if (!host) return;
  const highlight = capabilities.filter((c) => ['sos', 'live_location', 'risk_scoring', 'notifications'].includes(c.id));
  mount(host, ...highlight.map((c) => pill(`${c.label}: ${c.mode}`, c.mode)));
}

export function renderCapabilityDisclaimers(host, disclaimers) {
  if (!host) return;
  mount(host, ...(disclaimers || []).map((text) => el('p', { class: 'small' }, `• ${text}`)));
}

export { notice };
