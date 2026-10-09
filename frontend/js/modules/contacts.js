/**
 * Emergency contacts: list, add, edit, pause, verify, remove.
 *
 * Every field is rendered with `textContent` only. The UI is deliberately honest
 * about verification: a contact marked confirmed here has been confirmed **by
 * the account holder**, and says so. SheSafe cannot verify that a number belongs
 * to the person you named unless a verification provider is configured, in which
 * case the state is `provider_confirmed` and the badge changes.
 */

import { api } from '../core/api.js';
import { el, maskPhone, mount, relativeTime } from '../core/dom.js';
import {
  actionSheet, confirmSheet, dataList, dataRow, disclosure, emptyState,
  errorState, icon, notice, openSheet, pill, promptSheet, skeletonList,
} from '../core/ui.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

const CHANNEL_LABELS = { sms: 'SMS', whatsapp: 'WhatsApp', call: 'Call', push: 'Push' };
const RELATIONSHIPS = [
  'Mother', 'Father', 'Sister', 'Brother', 'Partner', 'Friend',
  'Colleague', 'Neighbour', 'Relative', 'Guardian', 'Roommate', 'Other',
];

/** Verification states, and exactly what each one means. */
const VERIFICATION = {
  unverified: { label: 'Unverified', tone: 'neutral', detail: 'Nobody has confirmed this number yet.' },
  self_confirmed: { label: 'Self-confirmed', tone: 'caution', detail: 'You told SheSafe this number is theirs. SheSafe cannot check that.' },
  pending: { label: 'Verification pending', tone: 'info', detail: 'A verification code was requested. SheSafe cannot deliver it without a configured provider.' },
  provider_confirmed: { label: 'Verified by provider', tone: 'safe', detail: 'A messaging provider confirmed that a code was delivered to this number and read back.' },
};

export const verificationState = (contact) => {
  if (contact.verifiedBy === 'provider') return 'provider_confirmed';
  if (contact.verified) return 'self_confirmed';
  if (contact.verificationRequestedAt) return 'pending';
  return 'unverified';
};

const verificationSpec = (contact) => VERIFICATION[verificationState(contact)];

/* ------------------------------------------------------------------ data */

export async function loadContacts({ silent = false } = {}) {
  const targets = Array.from(document.querySelectorAll('[data-contacts-list]'));
  if (!silent && targets.length) for (const target of targets) mount(target, skeletonList(2));
  try {
    const response = await api.listContacts();
    const contacts = response.contacts || [];
    store.set({ contacts });
    for (const target of targets) renderContacts(target, contacts);
    return contacts;
  } catch (error) {
    for (const target of targets) mount(target, errorState(error.message, () => loadContacts()));
    return [];
  }
}

/* ---------------------------------------------------------------- render */

export function renderContacts(target, contacts) {
  if (!contacts.length) {
    mount(target, emptyState({
      iconName: 'users',
      title: 'No trusted contacts yet',
      body: 'SheSafe cannot alert anyone until you add at least one person. Without contacts, an SOS records the incident and reminds you to call 112.',
      action: el('button', { class: 'btn btn--primary', type: 'button', onclick: () => openContactForm() }, icon('plus'), 'Add a contact'),
    }));
    return;
  }
  mount(target, dataList(contacts.map(contactRow)));
}

function contactRow(contact) {
  const spec = verificationSpec(contact);
  const channels = (contact.channels || []).map((channel) => CHANNEL_LABELS[channel] || channel);

  return dataRow({
    iconName: contact.isPrimary ? 'star' : 'users',
    title: contact.name,
    badges: [
      contact.isPrimary ? pill('Primary', 'brand') : null,
      pill(spec.label, spec.tone),
      contact.active ? null : pill('Paused', 'neutral'),
    ],
    meta: [
      contact.relationship || 'Contact',
      maskPhone(contact.phone),
      channels.length ? channels.join(' · ') : 'no channels',
      `added ${relativeTime(contact.createdAt)}`,
    ].filter(Boolean).join(' · '),
    body: disclosure('What this state means', el('p', { class: 'small' }, spec.detail)),
    actions: [
      el('a', { class: 'btn btn--quiet btn--sm', href: `tel:${String(contact.phone).replace(/[^+\d]/g, '')}`, 'aria-label': `Call ${contact.name}` }, icon('phone'), 'Call'),
      el('button', { class: 'btn btn--quiet btn--sm', type: 'button', 'aria-label': `Manage ${contact.name}`, onclick: () => void manageContact(contact) }, icon('pencil'), 'Manage'),
    ],
  });
}

/* -------------------------------------------------------------- manage */

async function manageContact(contact) {
  const choice = await actionSheet({
    title: contact.name,
    body: `${contact.relationship || 'Contact'} · ${maskPhone(contact.phone)} · ${contact.active ? 'active' : 'paused'}`,
    options: [
      { id: 'edit', label: 'Edit details', hint: 'Name, number, relationship or notification channels', iconName: 'pencil' },
      { id: 'primary', label: contact.isPrimary ? 'Not the primary contact' : 'Make this the primary contact', hint: 'The primary contact is listed first on every surface', iconName: 'star' },
      { id: 'active', label: contact.active ? 'Pause alerts to this contact' : 'Resume alerts to this contact', hint: contact.active ? 'SheSafe will keep the record but stop alerting them' : 'They will be alerted again on the next emergency', iconName: contact.active ? 'pause' : 'checkCircle' },
      { id: 'verify', label: 'Verification', hint: verificationSpec(contact).detail, iconName: 'key' },
      { id: 'remove', label: 'Remove this contact', hint: 'They will no longer be alerted. This cannot be undone.', iconName: 'trash' },
    ],
  });

  if (choice === 'edit') await editContact(contact);
  if (choice === 'primary') await patchContact(contact, { isPrimary: !contact.isPrimary }, contact.isPrimary ? 'No longer the primary contact.' : `${contact.name} is now the primary contact.`);
  if (choice === 'active') await patchContact(contact, { active: !contact.active }, contact.active ? `${contact.name} will not be alerted.` : `${contact.name} will be alerted again.`);
  if (choice === 'verify') await openVerification(contact);
  if (choice === 'remove') await removeContact(contact);
}

async function editContact(contact) {
  const choice = await actionSheet({
    title: `Edit ${contact.name}`,
    options: [
      { id: 'name', label: 'Change the name', hint: `Currently "${contact.name}"`, iconName: 'pencil' },
      { id: 'phone', label: 'Change the number', hint: `Currently ${maskPhone(contact.phone)}`, iconName: 'phone' },
      { id: 'relationship', label: 'Change the relationship', hint: `Currently ${contact.relationship || 'not set'}`, iconName: 'users' },
      { id: 'channels', label: 'Change notification channels', hint: `Currently ${(contact.channels || []).join(', ') || 'none'}`, iconName: 'message' },
    ],
  });
  if (!choice) return;

  if (choice === 'name') {
    const value = await promptSheet({ title: 'Contact name', label: 'Name', value: contact.name, maxLength: 80 });
    if (value) await patchContact(contact, { name: value }, 'Name updated.');
  }
  if (choice === 'phone') {
    const value = await promptSheet({ title: 'Mobile number', label: 'Mobile number', value: contact.phone, maxLength: 24 });
    if (value) await patchContact(contact, { phone: value }, 'Number updated.');
  }
  if (choice === 'relationship') {
    const choiceRel = await actionSheet({
      title: 'Relationship',
      options: RELATIONSHIPS.map((label) => ({ id: label, label })),
    });
    if (choiceRel) await patchContact(contact, { relationship: choiceRel }, 'Relationship updated.');
  }
  if (choice === 'channels') {
    const picked = await channelSheet(contact);
    if (picked) await patchContact(contact, { channels: picked }, 'Notification channels updated.');
  }
}

async function patchContact(contact, patch, message) {
  try {
    await api.updateContact(contact.id, patch);
    toast(message, 'success');
    await loadContacts({ silent: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removeContact(contact) {
  const confirmed = await confirmSheet({
    title: `Remove ${contact.name}?`,
    body: 'They will no longer be alerted, and the contact is deleted from your account.',
    confirmLabel: 'Remove contact',
    tone: 'danger',
    iconName: 'trash',
  });
  if (!confirmed) return;
  try {
    await api.deleteContact(contact.id);
    toast(`${contact.name} removed.`, 'success');
    await loadContacts({ silent: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* -------------------------------------------------------- verification */

async function openVerification(contact) {
  const state = verificationState(contact);
  const options = [];

  if (state === 'unverified' || state === 'self_confirmed') {
    options.push({ id: 'self', label: 'I have confirmed this number with them', hint: 'Records that you checked. SheSafe still cannot verify ownership on its own.', iconName: 'checkCircle' });
  }
  options.push({ id: 'request', label: 'Request a verification code', hint: 'Sends a one-time code to the number so the person can prove they own it. Requires a configured messaging provider.', iconName: 'key' });
  if (state !== 'unverified') {
    options.push({ id: 'reset', label: 'Reset verification', hint: 'Returns the contact to unverified', iconName: 'refresh' });
  }

  const choice = await actionSheet({
    title: `Verify ${contact.name}`,
    body: verificationSpec(contact).detail,
    options,
  });
  if (!choice) return;

  if (choice === 'self') {
    try {
      const response = await api.verifyContact(contact.id);
      toast(response.note || 'Marked as self-confirmed.', 'info', { timeout: 8000 });
      await loadContacts({ silent: true });
    } catch (error) { toast(error.message, 'error'); }
    return;
  }

  if (choice === 'request') {
    try {
      const response = await api.requestContactVerification(contact.id);
      const attempt = response.verification || {};
      if (attempt.mode === 'simulated') {
        toast('A verification code was recorded as SIMULATED. No message left the server because no messaging provider is configured.', 'warning', { timeout: 11000 });
      } else {
        toast('Verification code requested. Ask the person to read it back to you.', 'success');
      }
      if (attempt.code) {
        await promptSheet({
          title: `Code sent to ${maskPhone(contact.phone)}`,
          body: attempt.mode === 'simulated'
            ? 'SIMULATED: the code below was generated locally because no messaging provider is configured. It was not delivered to anyone.'
            : 'Ask the person to read the code back to you before entering it.',
          label: 'Code they read back',
          value: '',
          placeholder: attempt.code || '6 digits',
          hint: attempt.mode === 'simulated' ? `Locally generated code: ${attempt.code}` : 'Enter the code they read back',
          confirmLabel: 'Confirm code',
          maxLength: 12,
        });
      }
      await loadContacts({ silent: true });
    } catch (error) { toast(error.message, 'error'); }
    return;
  }

  if (choice === 'reset') await patchContact(contact, { verified: false }, 'Verification reset.');
}

/* ------------------------------------------------------------- add form */

export function contactForm() {
  const form = el('form', { id: 'contact-form' });

  const nameInput = el('input', { class: 'input', id: 'contact-name', name: 'name', required: true, maxlength: '80', autocomplete: 'off' });
  const phoneInput = el('input', { class: 'input', id: 'contact-phone', name: 'phone', type: 'tel', required: true, placeholder: '+91 98765 43210', autocomplete: 'off' });
  const relationSelect = el('select', { class: 'select', id: 'contact-relationship', name: 'relationship' },
    ...RELATIONSHIPS.map((label) => el('option', { value: label }, label)));
  const primaryInput = el('input', { type: 'checkbox', id: 'contact-primary' });

  const channelInputs = Object.keys(CHANNEL_LABELS).map((channel) => {
    const id = `contact-channel-${channel}`;
    return el('button', {
      class: 'chip', type: 'button', id, 'aria-pressed': channel === 'sms' ? 'true' : 'false',
      onclick: (event) => {
        const pressed = event.currentTarget.getAttribute('aria-pressed') === 'true';
        event.currentTarget.setAttribute('aria-pressed', pressed ? 'false' : 'true');
      },
    }, CHANNEL_LABELS[channel]);
  });

  form.append(el('div', { class: 'stack' },
    el('div', { class: 'field' }, el('label', { for: 'contact-name' }, 'Name'), nameInput),
    el('div', { class: 'field' }, el('label', { for: 'contact-phone' }, 'Mobile number'), phoneInput),
    el('div', { class: 'field' }, el('label', { for: 'contact-relationship' }, 'Relationship'), relationSelect),
    el('div', { class: 'field' },
      el('span', { class: 'field__label', id: 'channel-hint' }, 'How should we try to reach them?'),
      el('div', { class: 'chip-group', role: 'group', 'aria-labelledby': 'channel-hint' }, ...channelInputs)),
    el('label', { class: 'checkbox', for: 'contact-primary' }, primaryInput, 'Make this my primary contact'),
    notice('caution', 'SheSafe cannot verify the number belongs to them',
      'Choose channels the person actually uses. You can request a one-time verification code later; without a messaging provider it will be recorded as SIMULATED.'),
    el('button', { class: 'btn btn--primary btn--block', type: 'submit' }, icon('plus'), 'Add trusted contact')));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const channels = channelInputs
      .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
      .map((chip) => chip.id.replace('contact-channel-', ''));

    if (!channels.length) {
      toast('Choose at least one way to alert this contact.', 'warning');
      return;
    }
    try {
      await api.addContact({
        name: nameInput.value.trim(),
        phone: phoneInput.value.trim(),
        relationship: relationSelect.value,
        channels,
        isPrimary: primaryInput.checked,
      });
      toast(`${nameInput.value.trim()} added as a trusted contact.`, 'success');
      await loadContacts({ silent: true });
      form.reset();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  return form;
}

function channelSheet(contact) {
  return new Promise((resolve) => {
    const current = new Set(contact.channels || []);
    const body = el('div', { class: 'stack stack--tight' });
    const chips = Object.keys(CHANNEL_LABELS).map((channel) => {
      const chip = el('button', {
        class: 'chip', type: 'button', 'aria-pressed': current.has(channel) ? 'true' : 'false',
        onclick: (event) => {
          const pressed = event.currentTarget.getAttribute('aria-pressed') === 'true';
          event.currentTarget.setAttribute('aria-pressed', pressed ? 'false' : 'true');
        },
      }, CHANNEL_LABELS[channel]);
      body.appendChild(chip);
      return chip;
    });

    const dialog = el('dialog', { class: 'sheet', 'aria-label': 'Notification channels' });
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(value); };

    dialog.appendChild(el('div', { class: 'sheet__panel' },
      el('div', { class: 'sheet__grabber', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet__head' },
        el('h2', {}, 'Notification channels'),
        el('button', { class: 'sheet__close', type: 'button', 'aria-label': 'Close', onclick: () => finish(null) }, icon('x'))),
      body,
      el('div', { class: 'btn-row pad-top' },
        el('button', { class: 'btn btn--quiet btn--block', type: 'button', onclick: () => finish(null) }, 'Cancel'),
        el('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: () => {
          const picked = chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.textContent.toLowerCase());
          const mapped = picked.map((label) => Object.keys(CHANNEL_LABELS).find((k) => CHANNEL_LABELS[k].toLowerCase() === label));
          if (!mapped.length) { toast('Choose at least one channel.', 'warning'); return; }
          finish(mapped);
        } }, 'Save channels'))));
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) finish(null); });
    openSheet(dialog);
  });
}

export function openContactForm() {
  const dialog = document.getElementById('sheet-contact');
  if (dialog) openSheet(dialog);
}

export { CHANNEL_LABELS, RELATIONSHIPS };
