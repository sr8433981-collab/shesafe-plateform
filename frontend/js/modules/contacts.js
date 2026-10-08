/**
 * Emergency contacts: list, add, edit, verify, remove.
 * Rendered from API data with `textContent` only.
 */

import { api } from '../core/api.js';
import { el, emptyState, errorState, formatTime, maskPhone, mount, skeletonList } from '../core/dom.js';
import { toast } from '../core/feedback.js';
import { store } from '../core/store.js';

const CHANNEL_LABELS = { sms: 'SMS', whatsapp: 'WhatsApp', call: 'Call', push: 'Push' };
const RELATIONSHIPS = [
  'Mother', 'Father', 'Sister', 'Brother', 'Partner', 'Friend',
  'Colleague', 'Neighbour', 'Relative', 'Guardian', 'Roommate', 'Other',
];

export async function loadContacts({ silent = false } = {}) {
  const target = document.getElementById('contacts-list');
  if (!silent && target) mount(target, skeletonList(2));
  try {
    const response = await api.listContacts();
    store.set({ contacts: response.contacts || [] });
    if (target) renderContacts(target, response.contacts || []);
    const counter = document.getElementById('contacts-count');
    if (counter) counter.textContent = String((response.contacts || []).length);
    return response.contacts || [];
  } catch (error) {
    if (target) mount(target, errorState(error.message, () => loadContacts()));
    return [];
  }
}

export function renderContacts(target, contacts) {
  if (!contacts.length) {
    mount(
      target,
      emptyState({
        glyph: '＋',
        title: 'No trusted contacts yet',
        body: 'SheSafe cannot alert anyone until you add at least one person. Without contacts, an SOS records the incident and reminds you to call 112.',
        action: el('button', { class: 'btn btn--brand', type: 'button', onclick: () => document.getElementById('add-contact-modal')?.showModal() }, 'Add a contact'),
      }),
    );
    return;
  }
  mount(target, el('ul', { class: 'list' }, ...contacts.map(contactRow)));
}

function contactRow(contact) {
  const channelBadges = el(
    'div',
    { class: 'row', style: { gap: '4px', marginTop: '4px' } },
    ...(contact.channels || []).map((channel) =>
      el('span', { class: `badge ${channel === 'call' ? 'badge--muted' : 'badge--info'}` }, CHANNEL_LABELS[channel] || channel),
    ),
  );

  return el(
    'li',
    { class: 'list__item' },
    el('div', { class: 'list__icon', 'aria-hidden': 'true' }, contact.isPrimary ? '★' : '👤'),
    el(
      'div',
      { class: 'list__body' },
      el(
        'div',
        { class: 'list__title' },
        contact.name,
        contact.isPrimary ? el('span', { class: 'badge badge--danger', style: { marginLeft: '6px' } }, 'Primary') : null,
        contact.verified
          ? el('span', { class: 'badge badge--safe', style: { marginLeft: '6px' } }, 'Confirmed')
          : el('span', { class: 'badge badge--muted', style: { marginLeft: '6px' } }, 'Unconfirmed'),
        contact.active ? null : el('span', { class: 'badge badge--muted', style: { marginLeft: '6px' } }, 'Paused'),
      ),
      el('div', { class: 'list__meta' }, `${contact.relationship || 'Contact'} · ${maskPhone(contact.phone)} · added ${formatTime(contact.createdAt)}`),
      channelBadges,
    ),
    el(
      'div',
      { class: 'list__actions' },
      contact.verified
        ? null
        : el(
            'button',
            { class: 'btn btn--quiet', type: 'button', title: 'Mark as confirmed by you', onclick: () => verifyContact(contact.id) },
            'Confirm',
          ),
      el(
        'a',
        { class: 'btn btn--quiet', href: `tel:${String(contact.phone).replace(/[^+\d]/g, '')}`, 'aria-label': `Call ${contact.name}` },
        'Call',
      ),
      el('button', { class: 'btn btn--quiet', type: 'button', 'aria-label': `Remove ${contact.name}`, onclick: () => removeContact(contact) }, 'Remove'),
    ),
  );
}

async function verifyContact(id) {
  try {
    await api.verifyContact(id);
    toast('Marked as confirmed by you. SheSafe cannot independently verify phone ownership.', 'info', { timeout: 7000 });
    await loadContacts({ silent: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removeContact(contact) {
  const confirmed = window.confirm(`Remove ${contact.name} from your emergency contacts? They will no longer be alerted.`);
  if (!confirmed) return;
  try {
    await api.deleteContact(contact.id);
    toast(`${contact.name} removed.`, 'success');
    await loadContacts({ silent: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

/** Build the add-contact form body. Returns a DOM node for the modal. */
export function contactForm() {
  const form = el('form', { id: 'contact-form', method: 'dialog' });

  const nameInput = el('input', { class: 'input', id: 'contact-name', name: 'name', required: true, maxlength: '80', autocomplete: 'off' });
  const phoneInput = el('input', { class: 'input', id: 'contact-phone', name: 'phone', type: 'tel', required: true, placeholder: '+91 98765 43210', autocomplete: 'off' });
  const relationSelect = el(
    'select',
    { class: 'select', id: 'contact-relationship', name: 'relationship' },
    ...RELATIONSHIPS.map((label) => el('option', { value: label }, label)),
  );

  const channelInputs = Object.keys(CHANNEL_LABELS).map((channel) => {
    const id = `contact-channel-${channel}`;
    return el(
      'button',
      {
        class: 'chip',
        type: 'button',
        id,
        'aria-pressed': channel === 'sms' ? 'true' : 'false',
        onclick: (event) => {
          const pressed = event.currentTarget.getAttribute('aria-pressed') === 'true';
          event.currentTarget.setAttribute('aria-pressed', pressed ? 'false' : 'true');
        },
      },
      CHANNEL_LABELS[channel],
    );
  });

  const primaryInput = el('input', { type: 'checkbox', id: 'contact-primary' });

  form.append(
    el('div', { class: 'field' }, el('label', { for: 'contact-name' }, 'Name'), nameInput),
    el('div', { class: 'field' }, el('label', { for: 'contact-phone' }, 'Mobile number'), phoneInput),
    el('div', { class: 'field' }, el('label', { for: 'contact-relationship' }, 'Relationship'), relationSelect),
    el(
      'div',
      { class: 'field' },
      el('span', { class: 'field__hint', id: 'channel-hint' }, 'How should we try to reach them?'),
      el('div', { class: 'chip-group', role: 'group', 'aria-labelledby': 'channel-hint' }, ...channelInputs),
    ),
    el('label', { class: 'checkbox', for: 'contact-primary' }, primaryInput, 'Make this my primary contact'),
    el(
      'p',
      { class: 'tiny' },
      'SheSafe cannot verify that the number belongs to them. Choose channels you know they actually use.',
    ),
  );

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
      toast(`${nameInput.value.trim()} added as an emergency contact.`, 'success');
      await loadContacts({ silent: true });
      document.getElementById('add-contact-modal')?.close();
      form.reset();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  return form;
}

export { CHANNEL_LABELS, RELATIONSHIPS };