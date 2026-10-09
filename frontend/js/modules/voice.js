/**
 * Voice SOS.
 *
 * Optional, opt-in, and structurally incapable of alerting anyone on its own.
 * A recognised wake phrase starts the *same* countdown the button starts, so the
 * user still has to let it run out before anything happens. If the browser has no
 * speech recognition the feature is hidden with an explanation rather than
 * failing silently.
 */

import { el } from '../core/dom.js';
import { announceUrgent } from '../core/dom.js';
import { icon, notice, pill } from '../core/ui.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

const WAKE_PHRASES = ['shesafe emergency', 'she safe emergency', 'shesafe help', 'she safe help'];
const RESTART_MS = 1200;

let recognition = null;
let listening = false;
let restartTimer = null;
let transcript = '';
let arm = null;

export function isSupported() {
  return typeof window !== 'undefined'
    && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
    && Boolean(navigator.mediaDevices?.getUserMedia || true);
}

export async function start(onArm) {
  arm = typeof onArm === 'function' ? onArm : null;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return false;

  transcript = '';
  recognition = new Recognition();
  recognition.lang = 'en-IN';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      transcript += result[0].transcript;
    }
    if (wakePhraseSeen(transcript)) {
      transcript = '';
      if (arm) arm('voice');
    }
  };
  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setListening(false);
      toast('Microphone permission was denied. Voice SOS is off; the SOS button still works.', 'warning', { timeout: 9000 });
    }
  };
  recognition.onend = () => {
    // Recognition ends itself after silence. Restart while the feature is on,
    // but never in a tight loop.
    if (listening) {
      window.clearTimeout(restartTimer);
      restartTimer = window.setTimeout(() => { try { recognition.start(); } catch { setListening(false); } }, RESTART_MS);
    } else {
      setListening(false);
    }
  };

  try {
    recognition.start();
  } catch {
    return false;
  }
  setListening(true);
  announceUrgent('Voice SOS is listening for the wake phrase.');
  return true;
}

function wakePhraseSeen(text) {
  const normalised = ` ${String(text).toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ')} `;
  const hit = WAKE_PHRASES.find((phrase) => normalised.includes(` ${phrase} `));
  if (!hit) return false;
  toast(`Heard "${hit}" — starting the SOS cancel countdown.`, 'warning', { timeout: 8000 });
  return true;
}

export function stop() {
  listening = false;
  window.clearTimeout(restartTimer);
  if (recognition) {
    recognition.onend = null;
    try { recognition.stop(); } catch { /* already stopped */ }
    recognition = null;
  }
  setListening(false);
}

function setListening(value) {
  store.set({ voiceListening: value });
}

export function getTranscript() {
  return transcript;
}

/** The sheet body. Returns null when unsupported so the caller can explain. */
export function renderBody(handlers) {
  if (!isSupported()) {
    return [
      notice('caution', 'Voice SOS unavailable in this browser',
        'Speech recognition needs Chrome, Edge or Safari, a secure (https) connection and microphone permission. The SOS button works everywhere and needs nothing.'),
      el('p', { class: 'small' }, 'SheSafe will not offer a voice control that cannot work, and will not pretend it is listening.'),
    ];
  }

  return [
    notice('info', 'Voice SOS never alerts anyone on its own',
      'Say "SheSafe, emergency". That starts the same ten-second cancel countdown the button starts. Nothing is sent until the countdown runs out.'),
    el('div', { class: 'row row--tight' },
      el('span', { class: 'voice-wave', 'aria-hidden': 'true' }, el('span'), el('span'), el('span'), el('span')),
      el('span', { id: 'voice-status', class: 'grow' }, 'Not listening'),
      pill('Opt-in', 'neutral')),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn--primary btn--block', type: 'button', id: 'voice-toggle', onclick: () => void handlers.toggle() }, icon('mic'), 'Start listening'),
      el('button', { class: 'btn btn--quiet btn--block', type: 'button', onclick: handlers.close }, icon('x'), 'Close')),
    el('div', { class: 'field' },
      el('span', { class: 'field__label' }, 'Last heard'),
      el('p', { class: 'mono', id: 'voice-transcript' }, '—')),
    el('p', { class: 'small' }, 'Wake phrases: "SheSafe, emergency" · "SheSafe, help". Recognition is performed by your browser; SheSafe does not send audio anywhere.'),
  ];
}
