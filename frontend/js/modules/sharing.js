/**
 * Live location sharing: link lifecycle, revocation, guardian telemetry.
 */

import { api } from '../core/api.js';
import { locationManager } from '../core/location.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

export async function refreshShares() {
  try {
    const response = await api.activeShares();
    return response.shares || [];
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
    // The raw token is returned exactly once, by the API that mints it. Keep it
    // for this tab only so the copy/SMS buttons work; it is never persisted.
    window.sessionStorage.setItem('shesafe:lastShareUrl', response.shareUrl);
    // Sharing implies we need location streaming on.
    if (!locationManager.isStreaming) {
      await locationManager.start().catch(() => {});
    }
    toast('Live sharing started. The link expires automatically.', 'success');
    return response;
  } catch (error) {
    toast(error.message || 'Could not start sharing.', 'error');
    return null;
  }
}

export async function revokeSharing(shareId) {
  try {
    const response = await api.revokeSharing(shareId);
    store.set({ sharingActive: false });
    locationManager.stop();
    toast(shareId ? 'Link revoked.' : 'Sharing stopped and links revoked.', 'success');
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
    } else {
      window.prompt('Copy this tracking link:', url);
    }
    return true;
  } catch {
    window.prompt('Copy this tracking link:', url);
    return false;
  }
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
    `SheSafe: I am sharing my live location with you (${where}).\n${url}\n\n` +
      'The link expires automatically. This message was sent by me from my phone. ' +
      'If there is an emergency and I do not respond, call 112.',
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