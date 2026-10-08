/**
 * Voice-triggered SOS.
 *
 * Constraints, all deliberate:
 * * Requires `SpeechRecognition` (Chrome/Edge/Safari). Everywhere else the
 *   feature reports itself unavailable and hides itself - no silent degradation.
 * * Requires explicit user opt-in, microphone permission, and an arm button.
 * * The wake phrase starts the **same** countdown as the button. It never
 *   dispatches on its own. Speech recognition mistakes must not create an
 *   emergency silently.
 * * Always stoppable, and the transcript is shown so the user can see what was
 *   heard.
 */

import { store } from '../core/store.js';
import { arm } from './sos.js';
import { toast } from '../core/feedback.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isSupported() {
  return Boolean(Recognition);
}

export function isSecure() {
  return window.isSecureContext;
}

let recognition = null;
let listening = false;
let enabled = false;
let lastTranscript = '';

export function voiceState() {
  return { supported: isSupported(), secure: isSecure(), listening, enabled, lastTranscript };
}

/** Turn the microphone on. Resolves once listening begins. */
export async function start() {
  if (!isSupported()) {
    toast('This browser does not support speech recognition, so voice SOS is unavailable.', 'warning');
    return false;
  }
  if (!isSecure()) {
    toast('Voice SOS needs a secure (https) connection.', 'warning');
    return false;
  }
  if (listening) return true;

  recognition = new Recognition();
  recognition.lang = 'en-IN';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    store.set({ voiceListening: true });
  };

  recognition.onerror = (event) => {
    listening = false;
    store.set({ voiceListening: false });
    const messages = {
      'not-allowed': 'Microphone permission was denied.',
      'service-not-allowed': 'Speech recognition was blocked by the browser.',
      'no-speech': 'Nothing was heard. Try again.',
      network: 'Speech recognition needs a network connection in this browser.',
      aborted: 'Listening stopped.',
    };
    if (event.error !== 'aborted') {
      toast(messages[event.error] || `Voice SOS error: ${event.error}`, 'warning');
    }
  };

  recognition.onend = () => {
    listening = false;
    store.set({ voiceListening: false });
  };

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      transcript += event.results[i][0].transcript;
    }
    lastTranscript = transcript.trim();
    const heard = lastTranscript.toLowerCase();
    store.set({ voiceListening: listening });

    // Deliberately strict phrase matching. Anything less certain does nothing.
    const wakePhrase = heard.includes('she safe') || heard.includes('shesafe');
    const saysEmergency = /\b(emergency|help|sos|danger)\b/.test(heard);
    if (wakePhrase && saysEmergency) {
      toast(`Heard "${lastTranscript}" - starting the SOS countdown.`, 'warning', { timeout: 8000 });
      void arm('voice');
    } else if (wakePhrase) {
      toast(`Heard "${lastTranscript}". Say "SheSafe emergency" to start the countdown.`, 'info');
    }
  };

  try {
    recognition.start();
    enabled = true;
    return true;
  } catch (error) {
    toast('Could not start the microphone.', 'error');
    return false;
  }
}

export function stop() {
  if (recognition && listening) {
    try { recognition.stop(); } catch { /* already stopped */ }
  }
  enabled = false;
  listening = false;
  store.set({ voiceListening: false });
}

export function getTranscript() {
  return lastTranscript;
}