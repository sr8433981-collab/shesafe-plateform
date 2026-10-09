/**
 * Live location sharing: link lifecycle, revocation, guardian telemetry.
 *
 * The raw token is returned exactly once, by the API that mints it. It is kept
 * in `sessionStorage` for this tab only so the copy/SMS buttons work, and is
 * never written anywhere persistent.
 */

import { api } from '../core/api.js';
import { el, mount, relativeTime } from '../core/dom.js';
import {
  confirmSheet, dataList, dataRow, emptyState, icon,
  metric, metricGrid, notice, pill,
} from '../core/ui.js';
import { locationManager } from '../core/location.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

const LAST_URL_KEY = 'shesafe:lastShareUrl';

const PRIVACY_NOTES = [
  'Links use 256-bit random tokens; only a SHA-256 hash is stored, so a database leak cannot be replayed.',
  'Links expire automatically and can be revoked instantly.',
  'Your phone number is masked for the person following the link.',
  'Movement is only recorded as an incident trail while an SOS is open.',
  'GPS streaming stops when you close the tab or revoke sharing.',
];

export async function refreshShares() {
  try {
    const response = await api.activeShares();
    const shares = response.shares || [];
    store.set({ shares });
    return shares;
  } catch {
    return [];
  }
}

export async function startSharing({ includeTrail = null, ttlSeconds = 3600, label = 'Live location' } = {}) {
  try {
    const response = await api.startSharing({
      includeTrail: includeTrail ?? store.get().user?.shareTrailByDefault ?? true,
      ttlSeconds,
      label,
    });
    store.set({ sharingActive: true });
    window.sessionStorage.setItem(LAST_URL_KEY, response.shareUrl);
    if (!locationManager.isStreaming) await locationManager.start().catch(() => {});
    toast('Live sharing started. The link expires automatically.', 'success');
    return response;
  } catch (error) {
    toast(error.message || 'Could not start sharing.', 'error');
    return null;
  }
}

export async function revokeSharing(shareId) {
  if (!shareId) {
    const confirmed = await confirmSheet({
      title: 'Stop sharing and revoke every link?',
      body: 'Anyone holding one of these links loses access immediately, and GPS streaming stops.',
      confirmLabel: 'Stop sharing',
      tone: 'danger',
      iconName: 'x',
    });
    if (!confirmed) return null;
  }
  try {
    const response = await api.revokeSharing(shareId);
    store.set({ sharingActive: false });
    window.sessionStorage.removeItem(LAST_URL_KEY);
    if (!shareId) locationManager.stop();
    toast(shareId ? 'Link revoked.' : 'Sharing stopped and every link revoked.', 'success');
    return response;
  } catch (error) {
    toast(error.message || 'Could not revoke the link.', 'error');
    return null;
  }
}

export async function copyShareUrl(url) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
      toast('Tracking link copied.', 'success');
      return true;
    }
  } catch { /* fall through to the manual path */ }
  toast('Copy this tracking link from the field below.', 'info');
  return false;
}

/**
 * Build the message a user pastes into their own messaging app.
 *
 * This is the only "notification" channel that genuinely works in a browser:
 * the *user* sends it. SheSafe never claims to have sent it.
 */
export function smsShareText(url, address) {
  const where = address ? `near ${address}` : 'my current location';
  return encodeURIComponent(
    `SheSafe: I am sharing my live location with you (${where}).\n${url}\n\n`
      + 'The link expires automatically. This message was sent by me from my phone. '
      + 'If there is an emergency and I do not respond, call 112.',
  );
}

export function whatsappShareText(url, address) {
  const where = address ? `near ${address}` : 'my current location';
  return encodeURIComponent(
    `SheSafe live location (${where}):\n${url}\n\nSent by me. If I do not respond and you are worried, call 112.`,
  );
}

export async function refreshLatest() {
  try {
    const response = await api.latestLocation();
    store.set({
      location: response.location,
      locationAgeSeconds: response.ageSeconds,
      locationStale: response.stale,
      sharingActive: response.sharingActive,
    });
    return response;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ view */

export async function renderSharingView() {
  renderControls();
  markOrphanLinks();
  renderTelemetry();
  await Promise.allSettled([renderShares(), renderActions(), renderHelplines()]);
  renderPrivacyNotes();
}

export function renderControls() {
  const host = document.getElementById('sharing-controls');
  const badge = document.getElementById('sharing-status-badge');
  if (!host) return;
  const active = Boolean(store.get().sharingActive);

  if (badge) {
    badge.textContent = active ? 'Sharing' : 'Not sharing';
    badge.className = `badge ${active ? 'badge--safe' : 'badge--neutral'}`;
  }

  mount(host,
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn--primary btn--block', type: 'button', id: 'btn-start-share', disabled: active, onclick: () => void onStartShare() },
        icon('pin'), 'Start live sharing'),
      el('button', { class: 'btn btn--danger-ghost btn--block', type: 'button', id: 'btn-stop-share', disabled: !active, onclick: () => void revokeSharing() },
        icon('x'), 'Stop and revoke')),
    active
      ? el('p', { class: 'small' }, 'Anyone with a link can follow your position until it expires or you revoke it.')
      : el('p', { class: 'small' }, 'Nothing is shared until you start it.'));
}

async function onStartShare() {
  const result = await startSharing({ ttlSeconds: 3600 });
  if (!result) return;
  await renderSharingView();
}

export function renderTelemetry() {
  const target = document.getElementById('location-telemetry');
  if (!target) return;
  const { location, locationStale, sharingActive, locationError, locationPermission } = store.get();

  if (locationPermission === 'unsupported') {
    mount(target, notice('caution', 'Not supported', locationError || 'This browser has no location API.'));
    return;
  }
  if (!location) {
    mount(target, emptyState({
      iconName: 'pin',
      title: locationPermission === 'prompt' ? 'Location is off' : 'Waiting for a position',
      body: locationError || 'Switch location on to capture a position, share it, and score it.',
      action: el('a', { class: 'btn btn--primary', href: '#/home' }, icon('target'), 'Enable location on the dashboard'),
    }));
    return;
  }

  mount(target,
    metricGrid([
      metric('Status', locationStale ? 'STALE' : 'LIVE', { tone: locationStale ? 'caution' : 'safe' }),
      metric('Accuracy', `±${Math.round(location.accuracyM || 0)}`, { unit: 'm' }),
      metric('Last update', relativeTime(location.recordedAt)),
      metric('Battery', location.batteryPct != null ? String(location.batteryPct) : '—', { unit: location.batteryPct != null ? '%' : '' }),
    ]),
    el('p', { class: 'mono pad-top' }, `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`),
    locationStale
      ? notice('caution', 'Position may be out of date',
          'Nobody is currently sending location. This is the last fix SheSafe received, which may be old.')
      : sharingActive
        ? notice('safe', 'Sharing is active', 'Position updates while this page is open and location is on.')
        : notice('info', 'GPS on, not sharing', 'Position is used for SOS and safety scoring only.'));
}

export async function renderShares() {
  const target = document.getElementById('shares-list');
  if (!target) return;
  mount(target, el('p', { class: 'small' }, 'Loading links…'));
  const shares = await refreshShares();
  if (!shares.length) {
    mount(target, emptyState({ iconName: 'key', title: 'No links yet', body: 'Start sharing to create an expiring tracking link.' }));
    return;
  }
  mount(target, dataList(shares.map((share) => dataRow({
    iconName: 'key',
    title: share.label,
    badges: [
      pill(share.status, share.status === 'active' ? 'safe' : 'neutral'),
      share.linkedIncidentId ? pill('Linked to an incident', 'danger') : null,
    ],
    meta: `expires ${new Date(share.expiresAt).toLocaleString()} · ${share.viewCount} view${share.viewCount === 1 ? '' : 's'}${share.lastViewedAt ? ` · last viewed ${relativeTime(share.lastViewedAt)}` : ''} · trail ${share.includeTrail ? 'included' : 'excluded'}`,
    actions: share.status === 'active'
      ? [el('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: async () => { await revokeSharing(share.id); await renderShares(); renderControls(); } }, icon('x'), 'Revoke')]
      : [],
  }))));
}

export async function renderActions() {
  const target = document.getElementById('share-actions');
  if (!target) return;
  const url = currentShareUrl();

  mount(target,
    el('button', { class: 'btn btn--quiet btn--block', type: 'button', id: 'btn-copy-share', disabled: !url, onclick: () => url && copyShareUrl(url) }, icon('copy'), 'Copy link'),
    el('a', { class: `btn btn--quiet btn--block${url ? '' : ' btn--disabled'}`, id: 'btn-sms-share', href: url ? `sms:?&body=${smsShareText(url, store.get().location?.address)}` : undefined, 'aria-disabled': url ? null : 'true' }, icon('message'), 'Open SMS'),
    el('a', { class: `btn btn--quiet btn--block${url ? '' : ' btn--disabled'}`, id: 'btn-wa-share', href: url ? `https://wa.me/?text=${whatsappShareText(url, store.get().location?.address)}` : undefined, target: '_blank', rel: 'noopener noreferrer', 'aria-disabled': url ? null : 'true' }, icon('phone'), 'Open WhatsApp'),
    url
      ? el('div', { class: 'stack stack--tight' },
          el('label', { class: 'field__label', for: 'share-url-field' }, 'Your link (this tab only)'),
          el('input', { class: 'input mono', id: 'share-url-field', readonly: true, value: url }))
      : notice('caution', 'No active link', 'Start live sharing to get a link you can send.'));
}

function currentShareUrl() {
  return window.sessionStorage.getItem(LAST_URL_KEY);
}

/**
 * A link minted by an incident is returned to the browser once and is not in
 * `GET /location/share/active`, so the list alone would hide it. Say so instead
 * of leaving the user wondering where the link they were just given went.
 */
function markOrphanLinks() {
  const target = document.getElementById('shares-list');
  const url = currentShareUrl();
  if (!target || !url) return;
  target.appendChild(notice('info', 'A link was created for this incident',
    'It is shown below and ready to send. It expires automatically and you can revoke it at any time.'));
}

function renderPrivacyNotes() {
  const host = document.getElementById('sharing-privacy');
  if (!host) return;
  mount(host, ...PRIVACY_NOTES.map((note) => el('li', { class: 'small' }, `• ${note}`)));
}

/** The full published directory, rendered from the store. */
export function renderHelplines() {
  const target = document.getElementById('sharing-helplines');
  if (!target) return;
  const helplines = store.get().helplines || [];
  if (!helplines.length) {
    mount(target, el('p', { class: 'small' }, 'Loading published numbers…'));
    return;
  }
  mount(target, dataList(helplines.map((line) => dataRow({
    iconName: 'phone',
    title: line.title,
    badges: [pill(line.category, 'neutral')],
    meta: line.note,
    actions: [el('a', { class: 'btn btn--quiet btn--sm', href: `tel:${line.number}`, 'aria-label': `Call ${line.title} on ${line.number}` }, line.number)],
  }))));
}
