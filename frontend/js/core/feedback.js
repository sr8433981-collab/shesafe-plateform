/**
 * Toasts and the emergency siren.
 *
 * The siren is synthesised with the Web Audio API - no asset download, no
 * dependency. It is only ever started from a user gesture, which is what
 * browsers require before audio can play.
 */

import { el } from './dom.js';

const TOAST_STYLES = {
  info: { glyph: 'i', tone: '' },
  success: { glyph: '✓', tone: 'toast--safe' },
  warning: { glyph: '!', tone: 'toast--warn' },
  error: { glyph: '!', tone: 'toast--danger' },
};

function container() {
  let node = document.getElementById('toasts');
  if (!node) {
    node = el('div', { id: 'toasts', class: 'toasts', role: 'region', 'aria-label': 'Notifications' });
    document.body.appendChild(node);
  }
  return node;
}

export function toast(message, kind = 'info', { timeout = 5000 } = {}) {
  const { glyph, tone } = TOAST_STYLES[kind] || TOAST_STYLES.info;
  const node = el(
    'div',
    { class: `toast ${tone}`.trim(), role: kind === 'error' ? 'alert' : 'status' },
    el('span', { 'aria-hidden': 'true' }, glyph),
    el('div', { style: { flex: '1' } }, message),
    el('button', { class: 'toast__close', type: 'button', 'aria-label': 'Dismiss notification', onclick: () => node.remove() }, '×'),
  );
  container().appendChild(node);
  if (timeout) window.setTimeout(() => node.remove(), timeout);
  return node;
}

/* ------------------------------------------------------------- siren --- */

class Siren {
  constructor() {
    this.ctx = null;
    this.nodes = [];
    this.muted = false;
  }

  start() {
    if (this.muted) return false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      if (!this.ctx) this.ctx = new Ctx();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.stop();

      const now = this.ctx.currentTime;
      const oscillator = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      const gain = this.ctx.createGain();

      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(720, now);

      lfo.type = 'sine';
      lfo.frequency.value = 1.8;
      lfoGain.gain.value = 380;
      lfo.connect(lfoGain).connect(oscillator.frequency);

      // Soften the attack so the siren does not click.
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.15);

      oscillator.connect(gain).connect(this.ctx.destination);
      oscillator.start();
      lfo.start();
      this.nodes = [oscillator, lfo];
      return true;
    } catch (error) {
      console.warn('[SheSafe] audio unavailable:', error);
      return false;
    }
  }

  stop() {
    for (const node of this.nodes) {
      try { node.stop(); node.disconnect(); } catch { /* already stopped */ }
    }
    this.nodes = [];
  }

  toggle() {
    this.muted = !this.muted;
    if (this.muted) this.stop();
    return this.muted;
  }

  vibrate(pattern = [420, 180, 420, 180, 900]) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(pattern); } catch { /* blocked */ }
    }
  }
}

export const siren = new Siren();