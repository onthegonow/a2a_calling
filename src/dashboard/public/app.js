const state = {
  settings: null,
  dashboardStatus: null,
  autoUpdate: null,
  callbookDevices: [],
  contacts: [],
  selectedContactId: null,
  selectedContactCalls: [],
  contactCallResult: null,
  calls: [],
  invites: [],
  logs: [],
  logStats: null,
  trace: null,
  realtime: {
    connected: false,
    lastEventId: null
  },
  // A2A-47: Track active panel for sidebar navigation (replaces sl-tab-group)
  activeTab: 'contacts'
};

let dashboardEventSource = null;
let reconnectTimer = null;
let refreshTimer = null;

function showNotice(message) {
  const el = document.getElementById('notice');
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => {
    el.style.display = 'none';
  }, 3500);
}

function scheduleRealtimeRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    Promise.all([
      loadContacts().catch(() => {}),
      loadCalls().catch(() => {})
    ]).catch(() => {});
  }, 250);
}

function notifyRealtime(title, body) {
  const safeTitle = String(title || '').trim();
  if (!safeTitle) return;
  const safeBody = String(body || '').trim();
  if (typeof window.Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    try {
      // In A2A.app WebView this maps to native macOS notifications.
      new Notification(safeTitle, safeBody ? { body: safeBody } : undefined);
    } catch (err) {
      // Ignore notification errors.
    }
    return;
  }
  if (Notification.permission !== 'denied') {
    Notification.requestPermission().catch(() => {});
  }
}

function handleRealtimeEvent(eventData) {
  const type = String(eventData?.type || '').trim();
  const payload = eventData?.payload || {};
  if (!type) return;

  if (type === 'call.inbound') {
    const caller = payload.caller_name || 'Unknown agent';
    showNotice(`Inbound call: ${caller}`);
    notifyRealtime(`Inbound call from ${caller}`, 'Open A2A Callbook to respond.');
    scheduleRealtimeRefresh();
    return;
  }

  if (type === 'summary.completed') {
    const contact = payload.contact_name || 'conversation';
    showNotice(`Summary complete: ${contact}`);
    notifyRealtime('Summary complete', `Conversation with ${contact} has a summary.`);
    scheduleRealtimeRefresh();
    return;
  }

  if (type === 'contact.status.changed') {
    const contactId = String(payload.contact_id || '');
    const status = String(payload.status || '');
    if (contactId && status) {
      state.contacts = (state.contacts || []).map((contact) => {
        if (String(contact.id) !== contactId) return contact;
        return { ...contact, status };
      });
      renderContacts();
      renderContactDetail();
    } else {
      scheduleRealtimeRefresh();
    }
    return;
  }

  if (type === 'invite.used') {
    showNotice('Callbook install link used');
    loadCallbookDevices().catch(() => {});
    return;
  }

  if (type === 'call.updated') {
    scheduleRealtimeRefresh();
    return;
  }
}

function connectRealtimeEvents() {
  clearTimeout(reconnectTimer);
  if (dashboardEventSource) {
    dashboardEventSource.close();
    dashboardEventSource = null;
  }

  const qs = new URLSearchParams();
  if (state.realtime.lastEventId) {
    qs.set('since', String(state.realtime.lastEventId));
  }
  const endpoint = `/api/a2a/dashboard/events${qs.toString() ? `?${qs.toString()}` : ''}`;
  const source = new EventSource(endpoint);
  dashboardEventSource = source;

  source.onopen = () => {
    state.realtime.connected = true;
  };

  source.onerror = () => {
    state.realtime.connected = false;
    if (dashboardEventSource === source) {
      dashboardEventSource.close();
      dashboardEventSource = null;
    }
    reconnectTimer = setTimeout(connectRealtimeEvents, 1500);
  };

  const onAnyEvent = (evt) => {
    let payload = null;
    try {
      payload = evt?.data ? JSON.parse(evt.data) : null;
    } catch (_) {
      payload = null;
    }
    if (!payload || typeof payload !== 'object') return;
    if (payload.id) {
      state.realtime.lastEventId = String(payload.id);
    } else if (evt?.lastEventId) {
      state.realtime.lastEventId = String(evt.lastEventId);
    }
    handleRealtimeEvent(payload);
  };

  source.onmessage = onAnyEvent;
  source.addEventListener('call.inbound', onAnyEvent);
  source.addEventListener('call.updated', onAnyEvent);
  source.addEventListener('summary.completed', onAnyEvent);
  source.addEventListener('invite.used', onAnyEvent);
  source.addEventListener('contact.status.changed', onAnyEvent);
}

window.addEventListener('beforeunload', () => {
  if (dashboardEventSource) {
    dashboardEventSource.close();
    dashboardEventSource = null;
  }
});

async function request(path, options = {}) {
  const res = await fetch(`/api/a2a/dashboard${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || `Request failed: ${res.status}`);
  }
  return payload;
}

function toLines(values) {
  return (values || []).join('\n');
}

function fromLines(value) {
  return value
    .split('\n')
    .map(v => v.trim())
    .filter(Boolean);
}

function fmtDate(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch (err) {
    return String(value);
  }
}

function esc(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatUpdaterState(stateValue) {
  const state = String(stateValue || '').trim() || 'unknown';
  return state.replaceAll('_', ' ');
}

function badgeVariant(stateValue) {
  const state = String(stateValue || '').trim();
  if (state === 'failed') return 'danger';
  if (state === 'waiting_for_safe_restart' || state === 'checking' || state === 'downloading' || state === 'applying' || state === 'restarting') {
    return 'warning';
  }
  return 'success';
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // fall back
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (err) {
    return false;
  }
}

// A2A-47: Panel name → section title mapping for the content header
const panelTitles = {
  contacts: 'Contacts',
  calls: 'Calls',
  permissions: 'Permissions',
  invites: 'Invites',
  logs: 'Logs',
  health: 'Health'
};

// A2A-47: Show a specific panel and update sidebar + header state.
// Replaces the old sl-tab-group navigation.
function showPanel(name) {
  const validPanels = Object.keys(panelTitles);
  if (!validPanels.includes(name)) name = 'contacts';

  // Hide all panels, show the target
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('panel-' + name);
  if (target) target.classList.add('active');

  // Update sidebar active state
  document.querySelectorAll('.nav-item').forEach(item => {
    if (item.dataset.panel === name) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update header title
  const titleEl = document.getElementById('section-title');
  if (titleEl) titleEl.textContent = panelTitles[name] || name;

  // Update state and hash
  state.activeTab = name;
  try {
    if (window.location.hash.slice(1) !== name) {
      window.location.hash = name;
    }
  } catch (err) {}

  // Trigger data loading for the active tab
  if (typeof onTabSwitch === 'function') onTabSwitch(name);
}

function bindTabs() {
  // A2A-47: Sidebar nav click handler
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const panel = item.dataset.panel;
      if (panel) showPanel(panel);
    });
  });

  // Deep-link support: activate the panel matching the URL hash
  const activateFromHash = () => {
    let hash = window.location.hash.slice(1);
    // A2A-41: backward-compat alias — old bookmarks/links using #settings
    // still work after rename to #permissions
    if (hash === 'settings') hash = 'permissions';
    if (hash) {
      showPanel(hash);
    }
  };

  window.addEventListener('hashchange', activateFromHash);

  // On initial load, activate from hash
  activateFromHash();
}

function norm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getLocalOwnerName() {
  return state.dashboardStatus?.agent?.owner_name || state.dashboardStatus?.agent?.ownerName || '';
}

function isMine(contact) {
  return Boolean(contact?.is_mine);
}

function formatLocation(contact) {
  const host = String(contact?.host || contact?.web_address || '').trim();
  const server = String(contact?.server_name || contact?.serverName || '').trim();
  if (server && host && norm(server) !== norm(host)) {
    return `${server} (${host})`;
  }
  return server || host || '-';
}

function contactLabel(contact) {
  return String(contact?.name || '').trim() || String(contact?.host || '').trim() || '-';
}

function getPinnedContacts() {
  try {
    const raw = localStorage.getItem('a2a-pinned-contacts');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function togglePin(contactId) {
  const id = String(contactId || '');
  if (!id) return;
  const pinned = getPinnedContacts();
  const index = pinned.indexOf(id);
  if (index >= 0) {
    pinned.splice(index, 1);
  } else {
    pinned.push(id);
  }
  try {
    localStorage.setItem('a2a-pinned-contacts', JSON.stringify(pinned));
  } catch (err) {
    // localStorage may be unavailable
  }
  renderContacts();
}

function renderContacts() {
  const el = document.getElementById('contacts-sections');
  if (!el) return;

  const contacts = Array.isArray(state.contacts) ? state.contacts.slice() : [];
  const selected = state.selectedContactId ? String(state.selectedContactId) : '';

  const myAgents = contacts
    .filter(c => isMine(c))
    .sort((a, b) => contactLabel(a).localeCompare(contactLabel(b)));

  const pinnedIds = getPinnedContacts();
  const lastCalled = contacts
    .filter(c => c && c.last_call_at && !isMine(c))
    .sort((a, b) => {
      const aPinned = pinnedIds.includes(String(a.id));
      const bPinned = pinnedIds.includes(String(b.id));
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      return String(b.last_call_at || '').localeCompare(String(a.last_call_at || ''));
    })
    .slice(0, 12);

  const rowHtml = (c, opts = {}) => {
    const canCall = Boolean(c?.can_call);
    const mine = Boolean(c?.is_mine);
    const lastSummary = String(c?.last_owner_summary || c?.last_summary || '').trim();
    const summaryPreview = lastSummary ? lastSummary.slice(0, 120) : '-';
    const lastCallAt = c?.last_call_at ? fmtDate(c.last_call_at) : '-';
    const calls = Number.isFinite(c?.call_count) ? c.call_count : (c?.call_count || 0);
    const isSelected = selected && String(c?.id) === selected;
    const isPinned = pinnedIds.includes(String(c?.id));

    const actionBits = [];
    if (opts.showPin) {
      actionBits.push(`<sl-icon-button name="${isPinned ? 'pin-fill' : 'pin'}" class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-contact="${esc(c.id)}" title="${isPinned ? 'Unpin' : 'Pin to top'}"></sl-icon-button>`);
    }
    if (c?.last_call_id) {
      actionBits.push(`<sl-button size="small" data-open-call="${esc(c.last_call_id)}">Transcript</sl-button>`);
    }
    actionBits.push(`<sl-button size="small" data-toggle-mine="${esc(c.id)}">${mine ? 'Unmark mine' : 'Mark mine'}</sl-button>`);
    actionBits.push(`<sl-button size="small" variant="danger" data-remove-contact="${esc(c.id)}">Remove</sl-button>`);

    const locationCell = opts.showLocation ? `<td>${esc(formatLocation(c))}</td>` : '';
    const ownerCell = opts.showOwner ? `<td>${esc(c?.owner || '-')}</td>` : '';
    const summaryCell = opts.showSummary ? `<td title="${esc(lastSummary)}">${esc(summaryPreview)}</td>` : '';

    return `
      <tr ${isSelected ? 'data-selected="1"' : ''}>
        <td>
          <div class="row" style="margin:0;">
            <sl-button variant="text" size="small" data-contact-select="${esc(c.id)}">${esc(contactLabel(c))}</sl-button>
            <sl-button size="small" variant="primary" data-contact-call="${esc(c.id)}" ${canCall ? '' : 'disabled'}>Call</sl-button>
          </div>
        </td>
        ${locationCell}
        ${ownerCell}
        <td>${esc(c?.status || '-')}</td>
        <td>${esc(String(calls))}</td>
        <td>${esc(lastCallAt)}</td>
        ${summaryCell}
        <td>${actionBits.join(' ')}</td>
      </tr>
    `;
  };

  const tableHtml = (rows, opts = {}) => {
    const cols = [];
    cols.push('<th>Agent</th>');
    if (opts.showLocation) cols.push('<th>Location</th>');
    if (opts.showOwner) cols.push('<th>Owner</th>');
    cols.push('<th>Status</th>');
    cols.push('<th>Calls</th>');
    cols.push('<th>Last Call</th>');
    if (opts.showSummary) cols.push('<th>Last Summary</th>');
    cols.push('<th>Action</th>');

    if (!rows.length) {
      return `<table><thead><tr>${cols.join('')}</tr></thead><tbody><tr><td colspan="${cols.length}">(none)</td></tr></tbody></table>`;
    }

    return `<table><thead><tr>${cols.join('')}</tr></thead><tbody>${rows.map(c => rowHtml(c, opts)).join('')}</tbody></table>`;
  };

  const myAgentsSection = `
    <sl-card>
      <h3>My agents</h3>
      ${tableHtml(myAgents, { showLocation: true, showOwner: false, showSummary: false })}
    </sl-card>
  `;

  const lastCalledSection = `
    <sl-card>
      <h3>Last called agents</h3>
      ${tableHtml(lastCalled, { showLocation: false, showOwner: true, showSummary: false, showPin: true })}
    </sl-card>
  `;

  const otherContacts = contacts.filter(c => !isMine(c));
  const otherGroups = new Map();
  for (const c of otherContacts) {
    const owner = String(c?.owner || '').trim() || '(unknown owner)';
    if (!otherGroups.has(owner)) otherGroups.set(owner, []);
    otherGroups.get(owner).push(c);
  }

  const otherOwners = Array.from(otherGroups.keys()).sort((a, b) => {
    if (a === '(unknown owner)' && b !== '(unknown owner)') return 1;
    if (a !== '(unknown owner)' && b === '(unknown owner)') return -1;
    return a.localeCompare(b);
  });

  const groupedSections = otherOwners.map(owner => {
    const rows = (otherGroups.get(owner) || []).slice().sort((a, b) => contactLabel(a).localeCompare(contactLabel(b)));
    return `
      <sl-card>
        <h3>${esc(owner)}</h3>
        ${tableHtml(rows, { showLocation: false, showOwner: false, showSummary: true })}
      </sl-card>
    `;
  }).join('');

  const otherAgentsHeading = otherOwners.length
    ? `<h3 style="margin-top:1rem;">Other Agents</h3>`
    : '';

  el.innerHTML = `${myAgentsSection}${lastCalledSection}${otherAgentsHeading}${groupedSections}`;
}

async function loadContacts() {
  const payload = await request('/contacts');
  state.contacts = payload.contacts || [];
  renderContacts();
  renderContactDetail();
}

function bindContactsActions() {
  const form = document.getElementById('add-contact-form');
  if (!form) return;

  // Cancel button collapses the sl-details
  const cancelBtn = document.getElementById('add-contact-cancel');
  const addDetails = document.getElementById('add-contact-details');
  if (cancelBtn && addDetails) {
    cancelBtn.addEventListener('click', () => {
      addDetails.open = false;
    });
  }

  const urlEl = document.getElementById('add-contact-url');
  const mineEl = document.getElementById('add-contact-mine');
  const serverNameEl = document.getElementById('add-contact-server-name');
  const defaultServerNameFromUrl = () => {
    if (!urlEl || !serverNameEl) return;
    if (mineEl && !mineEl.checked) return;
    if (serverNameEl.value.trim()) return;
    const match = String(urlEl.value || '').trim().match(/^(?:a2a|oclaw):\/\/([^/]+)\//);
    if (match && match[1]) {
      serverNameEl.value = match[1];
    }
  };
  urlEl?.addEventListener('sl-blur', defaultServerNameFromUrl);
  urlEl?.addEventListener('sl-change', defaultServerNameFromUrl);
  mineEl?.addEventListener('sl-change', () => {
    if (!serverNameEl) return;
    serverNameEl.disabled = !mineEl.checked;
    if (mineEl.checked) {
      defaultServerNameFromUrl();
    }
  });
  if (serverNameEl && mineEl) {
    serverNameEl.disabled = !mineEl.checked;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = document.getElementById('add-contact-url').value.trim();
    const name = document.getElementById('add-contact-name').value.trim();
    const owner = document.getElementById('add-contact-owner').value.trim();
    const isMineVal = Boolean(document.getElementById('add-contact-mine')?.checked);
    const serverName = document.getElementById('add-contact-server-name').value.trim();
    const tagsRaw = document.getElementById('add-contact-tags').value.trim();
    const notes = document.getElementById('add-contact-notes').value.trim();
    const fieldsRaw = document.getElementById('add-contact-fields').value.trim();
    const tags = tagsRaw
      ? tagsRaw.split(',').map(v => v.trim()).filter(Boolean).slice(0, 30)
      : [];

    let fields = {};
    if (fieldsRaw) {
      try {
        const parsed = JSON.parse(fieldsRaw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Fields must be a JSON object');
        }
        fields = parsed;
      } catch (err) {
        showNotice(`Fields JSON invalid: ${err.message}`);
        return;
      }
    }

    try {
      await request('/contacts', {
        method: 'POST',
        body: JSON.stringify({
          invite_url: url,
          name: name || undefined,
          owner: owner || undefined,
          is_mine: isMineVal,
          server_name: serverName || undefined,
          tags,
          notes: notes || undefined,
          fields
        })
      });
      showNotice('Contact added');
      form.reset();
      // Collapse the sl-details after successful add
      if (addDetails) addDetails.open = false;
      await loadContacts();
    } catch (err) {
      showNotice(err.message);
    }
  });

  // A2A-47: Event delegation on the contacts panel (was sl-tab-panel, now div#panel-contacts)
  const panel = document.querySelector('#panel-contacts');
  panel?.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('[data-pin-contact]');
    if (pinBtn) {
      e.preventDefault();
      const id = pinBtn.dataset.pinContact;
      if (id) togglePin(id);
      return;
    }

    const selectBtn = e.target.closest('[data-contact-select]');
    if (selectBtn) {
      e.preventDefault();
      const id = selectBtn.dataset.contactSelect;
      if (id) {
        await loadCallsForContact(id);
      }
      return;
    }

    const openBtn = e.target.closest('[data-open-call]');
    if (openBtn) {
      e.preventDefault();
      openCallTranscript(openBtn.dataset.openCall);
      return;
    }

    const mineBtn = e.target.closest('[data-toggle-mine]');
    if (mineBtn) {
      e.preventDefault();
      const id = mineBtn.dataset.toggleMine;
      if (!id) return;

      const contact = (state.contacts || []).find(c => String(c.id) === String(id));
      const next = contact ? !Boolean(contact.is_mine) : true;

      mineBtn.disabled = true;
      try {
        await request(`/contacts/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ is_mine: next })
        });
        showNotice(next ? 'Marked as mine' : 'Unmarked');
        await loadContacts();
        if (state.selectedContactId && String(state.selectedContactId) === String(id)) {
          await loadCallsForContact(id);
        }
      } catch (err) {
        showNotice(err.message);
        mineBtn.disabled = false;
      }
      return;
    }

    const removeBtn = e.target.closest('[data-remove-contact]');
    if (removeBtn) {
      e.preventDefault();
      const id = removeBtn.dataset.removeContact;
      if (!id) return;
      removeBtn.disabled = true;
      try {
        await request(`/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        showNotice('Contact removed');
        if (state.selectedContactId && String(state.selectedContactId) === String(id)) {
          state.selectedContactId = null;
          state.selectedContactCalls = [];
          state.contactCallResult = null;
        }
        await loadContacts();
      } catch (err) {
        showNotice(err.message);
        removeBtn.disabled = false;
      }
      return;
    }

    const callBtn = e.target.closest('[data-contact-call]');
    if (callBtn) {
      e.preventDefault();
      const id = callBtn.dataset.contactCall;
      if (!id) return;

      const contact = (state.contacts || []).find(c => String(c.id) === String(id));
      if (!contact) {
        showNotice('Contact not found');
        return;
      }
      if (!contact.can_call) {
        showNotice('This contact has no callable A2A endpoint stored.');
        return;
      }

      // Quick-call: use existing draft message if available, else prompt.
      let message = '';
      const draftEl = document.getElementById('contact-call-message');
      if (state.selectedContactId && String(state.selectedContactId) === String(id) && draftEl && draftEl.value.trim()) {
        message = draftEl.value.trim();
      } else {
        const prompted = window.prompt(`Message to send to ${contactLabel(contact)}:`, 'Hello from my agent.');
        if (prompted === null) return;
        message = String(prompted || '').trim();
      }

      if (!message) {
        showNotice('Message required');
        return;
      }
      await callContact(id, message);
      return;
    }
  });
}

function renderCalls() {
  const tbody = document.querySelector('#calls-table tbody');
  tbody.innerHTML = '';
  state.calls.forEach(call => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${call.id}</td>
      <td>${call.contact?.name || call.contact_name || '-'}</td>
      <td>${call.status || '-'}</td>
      <td>${call.message_count || 0}</td>
      <td>${fmtDate(call.last_message_at)}</td>
      <td>${(call.summary || call.owner_summary || '-').slice(0, 120)}</td>
    `;
    tr.addEventListener('click', () => loadCallDetail(call.id));
    tbody.appendChild(tr);
  });
}

async function loadCalls() {
  const payload = await request('/calls?limit=200');
  state.calls = payload.calls || [];
  renderCalls();
}

async function loadCallDetail(conversationId) {
  const payload = await request(`/calls/${encodeURIComponent(conversationId)}?messages=40`);
  const call = payload.call;
  const el = document.getElementById('call-detail');

  // Summary: prefer agent-generated summary, fall back to owner summary
  const summaryText = call.summary || call.ownerContext?.summary || '';
  const summaryHtml = summaryText
    ? `<pre class="summary">${esc(summaryText)}</pre>`
    : `<p class="summary-pending"><em>${call.status === 'active' ? 'Call in progress\u2026' : 'Summary pending\u2026'}</em></p>`;

  // Full transcript in a collapsible section
  const messages = (call.recentMessages || []);
  const transcriptLines = messages
    .map(msg => `[${esc(fmtDate(msg.timestamp))}] ${esc(msg.direction)}: ${esc(msg.content)}`)
    .join('\n\n');
  const totalMessages = call.messageCount || messages.length;
  const countLabel = messages.length < totalMessages
    ? `${messages.length} of ${totalMessages} messages`
    : `${messages.length} message${messages.length === 1 ? '' : 's'}`;
  const transcriptHtml = messages.length
    ? `<sl-details class="transcript-details" summary="Full Transcript (${countLabel})">
        <pre class="transcript">${transcriptLines}</pre>
      </sl-details>`
    : '';

  el.innerHTML = `
    <h3>Call Detail: ${esc(call.id)}</h3>
    <p><strong>Contact:</strong> ${esc(call.contact?.name || call.contact || '-')}</p>
    <p><strong>Status:</strong> ${esc(call.status || '-')}</p>
    <p><strong>Summary:</strong></p>
    ${summaryHtml}
    ${transcriptHtml}
  `;
}

function renderContactDetail() {
  const el = document.getElementById('contact-detail');
  if (!el) return;

  const contactId = state.selectedContactId ? String(state.selectedContactId) : '';
  if (!contactId) {
    el.innerHTML = '<strong>Select a contact to view details and call history.</strong>';
    return;
  }

  const contact = (state.contacts || []).find(c => String(c.id) === contactId) || null;
  if (!contact) {
    el.innerHTML = '<strong>Selected contact not found.</strong>';
    return;
  }

  const calls = Array.isArray(state.selectedContactCalls) ? state.selectedContactCalls : [];
  const canCall = Boolean(contact.can_call);

  const tagsText = Array.isArray(contact.tags) ? contact.tags.join(', ') : '';
  const fieldsText = (() => {
    try {
      const obj = (contact.fields && typeof contact.fields === 'object') ? contact.fields : {};
      return JSON.stringify(obj, null, 2);
    } catch (err) {
      return '{}';
    }
  })();

  const result = state.contactCallResult;
  const resultHtml = result
    ? `<div style="margin-top:0.6rem;">
        <strong>Last call result:</strong> ${result.success ? 'success' : 'failed'}<br>
        ${result.conversation_id ? `Conversation: <span class="mono">${esc(result.conversation_id)}</span> <sl-button size="small" data-open-call="${esc(result.conversation_id)}">Transcript</sl-button><br>` : ''}
        ${result.error ? `<span class="mono">${esc(result.error)}</span><br>` : ''}
        ${result.response ? `<pre class="summary">${esc(String(result.response))}</pre>` : ''}
      </div>`
    : '';

  const callRows = calls.map(call => {
    const summary = String(call.summary || call.owner_summary || '').trim();
    const preview = summary ? summary.slice(0, 140) : '-';
    return `
      <tr>
        <td class="mono">${esc(call.id)}</td>
        <td>${esc(call.status || '-')}</td>
        <td>${esc(fmtDate(call.last_message_at))}</td>
        <td title="${esc(summary)}">${esc(preview)}</td>
        <td><sl-button size="small" data-open-call="${esc(call.id)}">Transcript</sl-button></td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div class="row">
      <h3 style="margin:0;">Contact: ${esc(contactLabel(contact))}</h3>
      <sl-button size="small" variant="primary" data-contact-call="${esc(contact.id)}" ${canCall ? '' : 'disabled'}>Call</sl-button>
      <sl-button size="small" variant="danger" data-remove-contact="${esc(contact.id)}">Remove</sl-button>
    </div>

    <div class="row" style="margin-bottom:0.4rem;">
      <div><strong>Mine:</strong> ${contact.is_mine ? 'yes' : 'no'}</div>
      <div><strong>Owner:</strong> ${esc(contact.owner || '-')}</div>
      <div><strong>Web address:</strong> <span class="mono">${esc(contact.web_address || contact.host || '-')}</span></div>
      <div><strong>Server name:</strong> ${esc(contact.server_name || '-')}</div>
    </div>
    <div class="row">
      <div><strong>Status:</strong> ${esc(contact.status || '-')}</div>
      <div><strong>Total calls:</strong> ${esc(String(contact.call_count || 0))}</div>
      <div><strong>Last call:</strong> ${esc(contact.last_call_at ? fmtDate(contact.last_call_at) : '-')}</div>
    </div>

    ${resultHtml}

    <sl-details summary="Edit contact" open style="margin-top:0.8rem;">
      <form id="contact-edit-form" data-contact-id="${esc(contact.id)}" style="margin-top:0.6rem;">
        <sl-input id="contact-edit-name" label="Agent name" value="${esc(contact.name || '')}"></sl-input>
        <sl-input id="contact-edit-owner" label="Owner name" value="${esc(contact.owner || '')}"></sl-input>
        <sl-checkbox id="contact-edit-mine" ${contact.is_mine ? 'checked' : ''}>Mark as mine (personal agent)</sl-checkbox>
        <sl-input id="contact-edit-server-name" label="Server name (my agents only)" value="${esc(contact.server_name || '')}" ${contact.is_mine ? '' : 'disabled'}></sl-input>
        <sl-input id="contact-edit-tags" label="Tags" value="${esc(tagsText)}" placeholder="comma,separated"></sl-input>
        <sl-textarea id="contact-edit-notes" label="Notes" rows="3" value="${esc(contact.notes || '')}"></sl-textarea>
        <sl-textarea id="contact-edit-fields" label="Fields (JSON)" rows="5" value="${esc(fieldsText)}"></sl-textarea>
        <div class="row">
          <sl-button type="submit" variant="primary" size="small">Save</sl-button>
        </div>
      </form>
    </sl-details>

    <sl-details summary="Call" open style="margin-top:0.8rem;">
      <form id="contact-call-form" data-contact-id="${esc(contact.id)}" style="margin-top:0.6rem;">
        <sl-textarea id="contact-call-message" label="Message" rows="4" placeholder="Message to send"></sl-textarea>
        <div class="row">
          <sl-button type="submit" variant="primary" size="small" ${canCall ? '' : 'disabled'}>Call</sl-button>
        </div>
      </form>
    </sl-details>

    <sl-details summary="Call history" style="margin-top:0.8rem;">
      <div style="margin-top:0.6rem;">
        <table>
          <thead><tr><th>ID</th><th>Status</th><th>Updated</th><th>Summary</th><th>Action</th></tr></thead>
          <tbody>${callRows || '<tr><td colspan="5">No calls found.</td></tr>'}</tbody>
        </table>
      </div>
    </sl-details>
  `;

  const editForm = document.getElementById('contact-edit-form');
  if (editForm) {
    const mineEl = document.getElementById('contact-edit-mine');
    const serverNameEl = document.getElementById('contact-edit-server-name');
    mineEl?.addEventListener('sl-change', () => {
      if (!serverNameEl) return;
      serverNameEl.disabled = !mineEl.checked;
    });

    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = editForm.dataset.contactId;
      if (!id) return;

      const tagsRaw = document.getElementById('contact-edit-tags').value.trim();
      const tags = tagsRaw
        ? tagsRaw.split(',').map(v => v.trim()).filter(Boolean).slice(0, 30)
        : [];

      let fields = {};
      const fieldsRaw = document.getElementById('contact-edit-fields').value.trim();
      if (fieldsRaw) {
        try {
          const parsed = JSON.parse(fieldsRaw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Fields must be a JSON object');
          }
          fields = parsed;
        } catch (err) {
          showNotice(`Fields JSON invalid: ${err.message}`);
          return;
        }
      }

      try {
        await request(`/contacts/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: document.getElementById('contact-edit-name').value,
            owner: document.getElementById('contact-edit-owner').value,
            is_mine: Boolean(document.getElementById('contact-edit-mine')?.checked),
            server_name: document.getElementById('contact-edit-server-name').value,
            notes: document.getElementById('contact-edit-notes').value,
            tags,
            fields
          })
        });
        showNotice('Contact saved');
        await loadContacts();
        await loadCallsForContact(id);
      } catch (err) {
        showNotice(err.message);
      }
    });
  }

  const callForm = document.getElementById('contact-call-form');
  if (callForm) {
    callForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = callForm.dataset.contactId;
      if (!id) return;
      const message = document.getElementById('contact-call-message').value.trim();
      if (!message) {
        showNotice('Message required');
        return;
      }
      await callContact(id, message);
    });
  }
}

function openCallTranscript(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  try { window.location.hash = 'calls'; } catch (err) {}
  // Let hashchange tab switch complete before rendering details.
  setTimeout(() => loadCallDetail(id).catch(err => showNotice(err.message)), 50);
}

async function callContact(contactId, message) {
  const id = String(contactId || '').trim();
  if (!id) return;
  state.selectedContactId = id;
  state.contactCallResult = { success: false, error: null, response: null, conversation_id: null };
  renderContactDetail();

  try {
    const result = await request(`/contacts/${encodeURIComponent(id)}/call`, {
      method: 'POST',
      body: JSON.stringify({ message })
    });
    state.contactCallResult = {
      success: true,
      response: result.response || '',
      conversation_id: result.conversation_id || null
    };
    showNotice('Call complete');
    await Promise.all([loadContacts(), loadCalls()]);
    await loadCallsForContact(id);
  } catch (err) {
    state.contactCallResult = { success: false, error: err.message, response: null, conversation_id: null };
    renderContactDetail();
    showNotice(err.message);
  }
}

async function loadCallsForContact(contactId, contactName) {
  const id = String(contactId || '').trim();
  if (!id) return;
  state.selectedContactId = id;

  try {
    const payload = await request(`/contacts/${encodeURIComponent(id)}/calls?limit=100`);
    state.selectedContactCalls = payload.calls || [];
  } catch (err) {
    state.selectedContactCalls = [];
  }

  renderContacts();
  renderContactDetail();
}

function readLogFilters() {
  const level = document.getElementById('logs-level').value.trim();
  const component = document.getElementById('logs-component').value.trim();
  const event = document.getElementById('logs-event').value.trim();
  const traceId = document.getElementById('logs-trace').value.trim();
  const conversationId = document.getElementById('logs-conversation').value.trim();
  const tokenId = document.getElementById('logs-token').value.trim();
  const search = document.getElementById('logs-search').value.trim();
  const limit = Number.parseInt(document.getElementById('logs-limit').value, 10) || 200;

  const params = new URLSearchParams();
  params.set('limit', String(Math.min(1000, Math.max(1, limit))));
  if (level) params.set('level', level);
  if (component) params.set('component', component);
  if (event) params.set('event', event);
  if (traceId) params.set('trace_id', traceId);
  if (conversationId) params.set('conversation_id', conversationId);
  if (tokenId) params.set('token_id', tokenId);
  if (search) params.set('search', search);

  return params;
}

function renderLogStats() {
  const el = document.getElementById('log-stats');
  if (!state.logStats) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  const stats = state.logStats;
  const levels = Object.entries(stats.by_level || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const components = Object.entries(stats.by_component || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  el.style.display = 'block';
  el.innerHTML = `
    <div class="row">
      <strong>Total:</strong> ${stats.total || 0}
    </div>
    <div class="row">
      <strong>By level:</strong> ${levels.map(([k, v]) => `${esc(k)}=${v}`).join(' \u00b7 ') || '(none)'}
    </div>
    <div class="row">
      <strong>Top components:</strong> ${components.map(([k, v]) => `${esc(k)}=${v}`).join(' \u00b7 ') || '(none)'}
    </div>
  `;
}

function renderTraceDetail() {
  const el = document.getElementById('trace-detail');
  if (!state.trace || !Array.isArray(state.trace.logs)) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  const logs = state.trace.logs || [];
  const lines = logs.map(row => {
    const msg = row.message || '';
    const meta = [
      row.component ? row.component : null,
      row.event ? row.event : null,
      row.error_code ? `code=${row.error_code}` : null,
      row.status_code ? `status=${row.status_code}` : null
    ].filter(Boolean).join(' ');
    return `[${fmtDate(row.timestamp)}] ${row.level?.toUpperCase() || ''} ${meta}\n${msg}${row.hint ? `\nHint: ${row.hint}` : ''}`;
  }).join('\n\n');

  el.innerHTML = `
    <div class="row">
      <h3 style="margin:0;">Trace: <span class="mono">${esc(state.trace.trace_id || '')}</span></h3>
      <sl-button id="clear-trace" size="small">Clear</sl-button>
    </div>
    <pre class="summary mono">${esc(lines || 'No trace logs.')}</pre>
  `;
  const clearBtn = document.getElementById('clear-trace');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.trace = null;
      renderTraceDetail();
    });
  }
}

function renderLogs() {
  const tbody = document.querySelector('#logs-table tbody');
  tbody.innerHTML = '';

  state.logs.forEach(row => {
    const tr = document.createElement('tr');
    const trace = row.trace_id || '';
    tr.innerHTML = `
      <td>${esc(fmtDate(row.timestamp))}</td>
      <td>${esc(row.level || '-')}</td>
      <td>${esc(row.component || '-')}</td>
      <td>${esc(row.event || '-')}</td>
      <td title="${esc(row.message || '')}">${esc(String(row.message || '').slice(0, 120) || '-')}</td>
      <td class="mono">${esc(trace ? trace.slice(0, 14) + '\u2026' : '-')}</td>
      <td class="mono">${esc(row.conversation_id ? row.conversation_id.slice(0, 14) + '\u2026' : '-')}</td>
      <td class="mono">${esc(row.token_id || '-')}</td>
      <td>${esc(row.error_code || '-')}</td>
      <td>${esc(row.status_code ?? '-')}</td>
    `;
    if (trace) {
      tr.addEventListener('click', () => loadTrace(trace).catch(err => showNotice(err.message)));
    }
    tbody.appendChild(tr);
  });
}

async function loadLogs() {
  const qs = readLogFilters().toString();
  const payload = await request(`/logs?${qs}`);
  state.logs = payload.logs || [];
  renderLogs();
}

async function loadLogStats() {
  const payload = await request('/logs/stats');
  state.logStats = payload.stats || null;
  renderLogStats();
}

async function loadTrace(traceId) {
  const payload = await request(`/logs/trace/${encodeURIComponent(traceId)}?limit=500`);
  state.trace = payload;
  renderTraceDetail();
}

// A2A-41: emoji map for visual tier differentiation. Standard tiers get
// recognizable icons; custom/user-created tiers get a wrench.
const TIER_EMOJIS = { public: '\u{1F310}', friends: '\u{1F46B}', family: '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}' };

// A2A-41: tool descriptions for the checkbox UI. These match the tools
// available in Claude Code that an agent owner might want to expose to callers.
const TOOL_DESCRIPTIONS = {
  'Bash': 'Execute shell commands \u2014 full access, can run anything',
  'Bash(readonly)': 'Execute read-only shell commands \u2014 no writes, no installs',
  'Read': 'Read files from the workspace',
  'Grep': 'Search file contents with regex patterns',
  'Glob': 'Find files by name patterns',
  'WebSearch': 'Search the web for information',
  'WebFetch': 'Fetch and read web page content'
};

// A2A-41: standard tier order for inheritance. Custom tiers are not in this list.
const TIER_ORDER = ['public', 'friends', 'family'];

// A2A-41: renders tool checkboxes instead of a textarea. Each tool gets
// a checkbox with its description. Checked state comes from tier.allowed_tools.
function renderToolCheckboxes(allowedTools) {
  const container = document.getElementById('tier-tools-list');
  container.innerHTML = Object.entries(TOOL_DESCRIPTIONS).map(([tool, desc]) => {
    const checked = (allowedTools || []).includes(tool) ? 'checked' : '';
    return `<sl-checkbox value="${esc(tool)}" ${checked}><strong>${esc(tool)}</strong> \u2014 <span class="tool-desc">${esc(desc)}</span></sl-checkbox>`;
  }).join('');
}

// A2A-41: renders topics as expandable card rows with descriptions.
// Data comes from tier.manifest.topics (array of {topic, description} objects).
// Falls back to tier.topics (flat string array) for topics without manifest data.
function renderTopicList(tier) {
  const container = document.getElementById('tier-topics-list');
  const manifestTopics = tier.manifest?.topics || [];
  const flatTopics = tier.topics || [];

  // A2A-41: prefer manifest data (has descriptions), fall back to flat array
  const allTopics = manifestTopics.length > 0
    ? manifestTopics.map(t => ({ label: t.topic, desc: t.description || '' }))
    : flatTopics.map(t => ({ label: t, desc: '' }));

  const rowsHtml = allTopics.map(t => `
    <div class="topic-row" data-topic="${esc(t.label)}" data-type="topic">
      <span class="drag-handle">\u2807</span>
      <div class="topic-content">
        <div class="topic-header">
          <strong class="topic-label">${esc(t.label)}</strong>
          <sl-icon-button name="chevron-down" class="topic-expand-btn" label="Expand"></sl-icon-button>
          <sl-icon-button name="trash" class="topic-delete-btn" label="Delete"></sl-icon-button>
        </div>
        <div class="topic-description" style="display:none;">
          <p class="topic-desc-text">${esc(t.desc) || '<em>No description</em>'}</p>
          <sl-input class="topic-desc-edit" size="small" placeholder="Add description..." value="${esc(t.desc)}"></sl-input>
        </div>
      </div>
    </div>
  `).join('');

  container.innerHTML = rowsHtml + `<button class="add-item-btn" data-type="topic">+ Add topic</button>`;
}

// A2A-41: renders goals as expandable card rows, identical pattern to topics.
// Data from tier.manifest.objectives (array of {objective, description}).
function renderGoalList(tier) {
  const container = document.getElementById('tier-goals-list');
  const manifestGoals = tier.manifest?.objectives || [];
  const flatGoals = tier.goals || [];

  const allGoals = manifestGoals.length > 0
    ? manifestGoals.map(g => ({ label: g.objective || g.topic, desc: g.description || '' }))
    : flatGoals.map(g => ({ label: g, desc: '' }));

  const rowsHtml = allGoals.map(g => `
    <div class="topic-row" data-topic="${esc(g.label)}" data-type="goal">
      <span class="drag-handle">\u2807</span>
      <div class="topic-content">
        <div class="topic-header">
          <strong class="topic-label">${esc(g.label)}</strong>
          <sl-icon-button name="chevron-down" class="topic-expand-btn" label="Expand"></sl-icon-button>
          <sl-icon-button name="trash" class="topic-delete-btn" label="Delete"></sl-icon-button>
        </div>
        <div class="topic-description" style="display:none;">
          <p class="topic-desc-text">${esc(g.desc) || '<em>No description</em>'}</p>
          <sl-input class="topic-desc-edit" size="small" placeholder="Add description..." value="${esc(g.desc)}"></sl-input>
        </div>
      </div>
    </div>
  `).join('');

  container.innerHTML = rowsHtml + `<button class="add-item-btn" data-type="goal">+ Add goal</button>`;
}

// A2A-41: event delegation for topic and goal list interactions.
// Uses a single click handler on each container instead of per-row binding,
// preventing listener accumulation when topics are added dynamically.
function bindItemListDelegation() {
  ['tier-topics-list', 'tier-goals-list'].forEach(containerId => {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.addEventListener('click', (e) => {
      // Expand/collapse
      const expandBtn = e.target.closest('.topic-expand-btn');
      if (expandBtn) {
        const row = expandBtn.closest('.topic-row');
        const desc = row.querySelector('.topic-description');
        if (desc) {
          const isHidden = desc.style.display === 'none';
          desc.style.display = isHidden ? '' : 'none';
          expandBtn.name = isHidden ? 'chevron-up' : 'chevron-down';
        }
        return;
      }

      // Delete
      const deleteBtn = e.target.closest('.topic-delete-btn');
      if (deleteBtn) {
        deleteBtn.closest('.topic-row').remove();
        return;
      }

      // Add new item
      const addBtn = e.target.closest('.add-item-btn');
      if (addBtn) {
        const type = addBtn.dataset.type;
        const label = type === 'topic' ? 'Topic name' : 'Goal name';
        const newRow = document.createElement('div');
        newRow.className = 'topic-row';
        newRow.dataset.type = type;
        newRow.innerHTML = `
          <span class="drag-handle">\u2807</span>
          <div class="topic-content">
            <sl-input class="new-item-label" size="small" placeholder="${label}" autofocus></sl-input>
            <sl-input class="new-item-desc" size="small" placeholder="Description (optional)"></sl-input>
            <div class="row" style="margin-top:0.3rem;">
              <sl-button size="small" variant="primary" class="confirm-add-btn">Add</sl-button>
              <sl-button size="small" class="cancel-add-btn">Cancel</sl-button>
            </div>
          </div>
        `;
        container.insertBefore(newRow, addBtn);
        return;
      }

      // Confirm add
      const confirmBtn = e.target.closest('.confirm-add-btn');
      if (confirmBtn) {
        const row = confirmBtn.closest('.topic-row');
        const nameInput = row.querySelector('.new-item-label');
        const descInput = row.querySelector('.new-item-desc');
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }

        row.dataset.topic = name;
        row.innerHTML = `
          <span class="drag-handle">\u2807</span>
          <div class="topic-content">
            <div class="topic-header">
              <strong class="topic-label">${esc(name)}</strong>
              <sl-icon-button name="chevron-down" class="topic-expand-btn" label="Expand"></sl-icon-button>
              <sl-icon-button name="trash" class="topic-delete-btn" label="Delete"></sl-icon-button>
            </div>
            <div class="topic-description" style="display:none;">
              <p class="topic-desc-text">${esc(descInput.value)}</p>
              <sl-input class="topic-desc-edit" size="small" placeholder="Add description..." value="${esc(descInput.value)}"></sl-input>
            </div>
          </div>
        `;
        return;
      }

      // Cancel add
      const cancelBtn = e.target.closest('.cancel-add-btn');
      if (cancelBtn) {
        cancelBtn.closest('.topic-row').remove();
        return;
      }
    });

    // Description edit via sl-change (Shoelace event, delegated)
    container.addEventListener('sl-change', (e) => {
      const input = e.target.closest('.topic-desc-edit');
      if (input) {
        const row = input.closest('.topic-row');
        const textEl = row.querySelector('.topic-desc-text');
        if (textEl) textEl.textContent = input.value || '';
      }
    });
  });
}

function fillTierSelects() {
  const tiers = (state.settings?.tiers || []).slice().sort((a, b) => a.id.localeCompare(b.id));
  const tierSelect = document.getElementById('tier-select');
  const copyFrom = document.getElementById('copy-from-tier');
  const newTierCopy = document.getElementById('new-tier-copy-from');
  const inviteTier = document.getElementById('invite-tier');

  const optionsHtml = tiers.map(tier => {
    const emoji = TIER_EMOJIS[tier.id] || '\u{1F527}';
    return `<sl-option value="${esc(tier.id)}">${emoji} ${esc(tier.name || tier.id)}</sl-option>`;
  }).join('');

  tierSelect.innerHTML = optionsHtml;
  copyFrom.innerHTML = optionsHtml;
  inviteTier.innerHTML = optionsHtml;
  newTierCopy.innerHTML = `<sl-option value="">None</sl-option>${optionsHtml}`;

  // A2A-41: default to 'public' — it's the base tier and most commonly edited
  const defaultTier = tiers.find(t => t.id === 'public') ? 'public' : tiers[0]?.id;
  if (defaultTier) {
    tierSelect.value = defaultTier;
    copyFrom.value = defaultTier;
    inviteTier.value = defaultTier;
    renderTierEditor(defaultTier);
  }
}

function renderTierEditor(tierId) {
  const tier = (state.settings?.tiers || []).find(t => t.id === tierId);
  if (!tier) return;

  document.getElementById('tier-name').value = tier.name || tier.id;
  document.getElementById('tier-description').value = tier.description || '';
  renderToolCheckboxes(tier.allowed_tools);
  renderTopicList(tier);
  renderGoalList(tier);
  renderTierWarnings(tier);
  renderTierColumns();
}

// A2A-41: renders the three-column drag zone showing all standard tiers
// side-by-side. Inherited topics shown as grayed-out non-draggable rows.
// Custom tiers are not shown here — they don't have a defined inheritance
// hierarchy. HTML5 drag-and-drop does NOT work on touch devices (mobile).
function renderTierColumns() {
  const container = document.getElementById('tier-columns');
  if (!container) return;
  const tiers = state.settings?.tiers || [];
  const toggle = document.getElementById('show-drag-columns');
  container.style.display = toggle?.checked ? '' : 'none';

  const html = TIER_ORDER.map(tierId => {
    const tier = tiers.find(t => t.id === tierId);
    if (!tier) return '';

    const emoji = TIER_EMOJIS[tierId] || '\u{1F527}';
    const tierIdx = TIER_ORDER.indexOf(tierId);

    // Inherited topics from lower tiers
    let inheritedRows = '';
    for (let i = 0; i < tierIdx; i++) {
      const lowerTier = tiers.find(t => t.id === TIER_ORDER[i]);
      if (!lowerTier) continue;
      const lowerTopics = lowerTier.manifest?.topics?.length
        ? lowerTier.manifest.topics
        : (lowerTier.topics || []).map(t => ({ topic: t, description: '' }));
      lowerTopics.forEach(t => {
        inheritedRows += `
          <div class="topic-row inherited" data-topic="${esc(t.topic)}" data-tier="${esc(TIER_ORDER[i])}">
            <div class="topic-content">
              <div class="topic-header">
                <strong class="topic-label">${esc(t.topic)}</strong>
                <span class="inherited-badge">from ${esc(TIER_ORDER[i])}</span>
              </div>
            </div>
          </div>`;
      });
    }

    // Own topics — draggable
    const ownTopics = tier.manifest?.topics?.length
      ? tier.manifest.topics
      : (tier.topics || []).map(t => ({ topic: t, description: '' }));
    const ownRows = ownTopics.map(t => `
      <div class="topic-row" draggable="true" data-topic="${esc(t.topic)}" data-tier="${esc(tierId)}">
        <span class="drag-handle">\u2807</span>
        <div class="topic-content">
          <div class="topic-header">
            <strong class="topic-label">${esc(t.topic)}</strong>
          </div>
        </div>
      </div>
    `).join('');

    return `
      <div class="tier-column" data-tier="${esc(tierId)}">
        <h4>${emoji} ${esc(tier.name || tierId)}</h4>
        <div class="tier-drop-zone" data-tier="${esc(tierId)}">
          ${inheritedRows}${ownRows}
        </div>
      </div>`;
  }).join('');

  container.innerHTML = html;
  bindDragEvents();
}

// A2A-41: HTML5 drag-and-drop handlers for moving topics between tier columns.
// On drop, both tiers are saved via Promise.all() to prevent data loss if one
// request fails. On error, state is reloaded from server to reset UI.
function bindDragEvents() {
  const zones = document.querySelectorAll('.tier-drop-zone');

  document.querySelectorAll('.tier-columns .topic-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify({
        topic: row.dataset.topic,
        sourceTier: row.dataset.tier
      }));
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  });

  zones.forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');

      let data;
      try { data = JSON.parse(e.dataTransfer.getData('application/json')); } catch { return; }
      const { topic, sourceTier } = data;
      const targetTier = zone.dataset.tier;

      if (!topic || !sourceTier || !targetTier || sourceTier === targetTier) return;

      const sourceTierData = (state.settings?.tiers || []).find(t => t.id === sourceTier);
      const targetTierData = (state.settings?.tiers || []).find(t => t.id === targetTier);
      if (!sourceTierData || !targetTierData) return;

      const sourceTopics = (sourceTierData.topics || []).filter(t => t !== topic);
      const sourceManifestTopics = (sourceTierData.manifest?.topics || []).filter(t => t.topic !== topic);
      const movedManifest = (sourceTierData.manifest?.topics || []).find(t => t.topic === topic);
      const targetTopics = [...(targetTierData.topics || []), topic];
      const targetManifestTopics = [...(targetTierData.manifest?.topics || []), movedManifest || { topic, description: '' }];

      // A2A-41: save both tiers atomically with Promise.all to prevent
      // data loss if one request fails. On error, reload from server.
      try {
        await Promise.all([
          request(`/settings/tiers/${encodeURIComponent(sourceTier)}`, {
            method: 'PUT',
            body: JSON.stringify({
              topics: sourceTopics,
              manifest: { topics: sourceManifestTopics, objectives: sourceTierData.manifest?.objectives || [] }
            })
          }),
          request(`/settings/tiers/${encodeURIComponent(targetTier)}`, {
            method: 'PUT',
            body: JSON.stringify({
              topics: targetTopics,
              manifest: { topics: targetManifestTopics, objectives: targetTierData.manifest?.objectives || [] }
            })
          })
        ]);
        showNotice(`Moved "${topic}" from ${sourceTier} to ${targetTier}`);
      } catch (err) {
        showNotice(`Move failed: ${err.message}. Reloading...`);
      }
      await loadSettings();
    });
  });
}

// A2A-41: contextual validation warnings for the currently selected tier.
// Warns about empty tiers, dangerous tool grants, and inverted tier sizes.
function renderTierWarnings(tier) {
  const container = document.getElementById('tier-warnings');
  if (!container) return;
  const warnings = [];

  // A2A-41: use manifest OR flat topics (not both) to avoid double-counting.
  // Manifest is preferred when non-empty; flat array is the fallback.
  // NOTE: can't use || for this because empty arrays are truthy in JS.
  const mTopics = tier.manifest?.topics;
  const topicCount = (mTopics && mTopics.length > 0 ? mTopics : (tier.topics || [])).length;
  if (topicCount === 0) {
    warnings.push({ level: 'warn', text: "This tier has no topics \u2014 callers won't have conversation context." });
  }

  if (tier.id === 'public' && (tier.allowed_tools || []).includes('Bash')) {
    warnings.push({ level: 'danger', text: 'Bash (full access) is granted to the public tier \u2014 any caller can execute commands.' });
  }

  if (tier.id === 'family') {
    const allTiers = state.settings?.tiers || [];
    const friends = allTiers.find(t => t.id === 'friends');
    if (friends) {
      const mFam = tier.manifest?.topics;
      const familyOwn = (mFam && mFam.length > 0 ? mFam : (tier.topics || [])).length;
      const mFri = friends.manifest?.topics;
      const friendsOwn = (mFri && mFri.length > 0 ? mFri : (friends.topics || [])).length;
      if (familyOwn < friendsOwn) {
        warnings.push({ level: 'info', text: 'Family tier has fewer topics than Friends \u2014 usually Family is the most open tier.' });
      }
    }
  }

  container.innerHTML = warnings.map(w =>
    `<div class="tier-warning ${w.level}">${esc(w.text)}</div>`
  ).join('');
}

// A2A-41: merges topics/goals/tools from the selected tier and all lower tiers,
// mirroring the backend's getTopicsForTier() inheritance. Used by the preview dialog.
function getPreviewData(tierId) {
  const selectedIndex = TIER_ORDER.indexOf(tierId);
  const tiers = state.settings?.tiers || [];
  const merged = { topics: [], objectives: [], tools: new Set(), do_not_discuss: [], never_disclose: [] };

  // A2A-41: for custom tiers not in TIER_ORDER, show only own data.
  // No inheritance is applied because custom tiers have no defined hierarchy.
  if (selectedIndex < 0) {
    const t = tiers.find(t => t.id === tierId);
    if (t) {
      (t.manifest?.topics || []).forEach(item => merged.topics.push({ ...item, source: tierId }));
      (t.manifest?.objectives || []).forEach(item => merged.objectives.push({ ...item, source: tierId }));
      (t.allowed_tools || []).forEach(tool => merged.tools.add(tool));
    }
    merged.never_disclose = state.settings?.manifest?.never_disclose || [];
    return merged;
  }

  for (let i = 0; i <= selectedIndex; i++) {
    const t = tiers.find(t => t.id === TIER_ORDER[i]);
    if (!t) continue;
    (t.manifest?.topics || []).forEach(item => merged.topics.push({ ...item, source: TIER_ORDER[i] }));
    (t.manifest?.objectives || []).forEach(item => merged.objectives.push({ ...item, source: TIER_ORDER[i] }));
    (t.manifest?.do_not_discuss || []).forEach(item => {
      if (!merged.do_not_discuss.includes(item)) merged.do_not_discuss.push(item);
    });
    (t.allowed_tools || []).forEach(tool => merged.tools.add(tool));
  }

  merged.never_disclose = state.settings?.manifest?.never_disclose || [];
  return merged;
}

// A2A-41: opens the caller preview dialog showing the merged effective view
// for the selected tier. Helps the agent owner understand what a caller sees.
function openCallerPreview() {
  const tierId = document.getElementById('tier-select').value;
  const data = getPreviewData(tierId);
  const emoji = TIER_EMOJIS[tierId] || '\u{1F527}';
  const tierName = (state.settings?.tiers || []).find(t => t.id === tierId)?.name || tierId;

  const dialog = document.getElementById('preview-dialog');
  dialog.label = `\u{1F441} Caller Preview \u2014 ${emoji} ${tierName}`;

  const topicsList = data.topics.length > 0
    ? data.topics.map(t => `<li><strong>${esc(t.topic)}</strong>${t.description ? ` \u2014 ${esc(t.description)}` : ''}</li>`).join('')
    : '<li><em>None configured</em></li>';

  const goalsList = data.objectives.length > 0
    ? data.objectives.map(g => `<li><strong>${esc(g.objective || g.topic)}</strong>${g.description ? ` \u2014 ${esc(g.description)}` : ''}</li>`).join('')
    : '<li><em>None configured</em></li>';

  const toolsList = data.tools.size > 0
    ? Array.from(data.tools).map(t => `<li><strong>${esc(t)}</strong>${TOOL_DESCRIPTIONS[t] ? ` \u2014 ${esc(TOOL_DESCRIPTIONS[t])}` : ''}</li>`).join('')
    : '<li><em>None configured</em></li>';

  const dndList = data.do_not_discuss.length > 0
    ? data.do_not_discuss.map(d => `<li>${esc(typeof d === 'string' ? d : d.topic || '')}</li>`).join('')
    : '<li><em>None configured</em></li>';

  const neverList = data.never_disclose.length > 0
    ? data.never_disclose.map(n => `<li>${esc(n)}</li>`).join('')
    : '<li><em>None configured</em></li>';

  document.getElementById('preview-content').innerHTML = `
    <h4>Topics this caller can discuss:</h4>
    <ul>${topicsList}</ul>
    <h4>Goals:</h4>
    <ul>${goalsList}</ul>
    <h4>Tools available:</h4>
    <ul>${toolsList}</ul>
    <h4>Will not discuss:</h4>
    <ul>${dndList}</ul>
    <h4>Never disclosed (any tier):</h4>
    <ul>${neverList}</ul>
  `;

  dialog.show();
}

function bindSettingsActions() {
  document.getElementById('tier-select').addEventListener('sl-change', (e) => {
    renderTierEditor(e.target.value);
  });

  document.getElementById('tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tierId = document.getElementById('tier-select').value;

    // A2A-41: collect tools from checkboxes
    const toolCheckboxes = document.querySelectorAll('#tier-tools-list sl-checkbox');
    const allowed_tools = Array.from(toolCheckboxes)
      .filter(cb => cb.checked)
      .map(cb => cb.value);

    // A2A-41: collect topics from row elements
    const topicRows = document.querySelectorAll('#tier-topics-list .topic-row[data-topic]');
    const topics = Array.from(topicRows).map(row => row.dataset.topic).filter(Boolean);
    const manifestTopics = Array.from(topicRows).map(row => ({
      topic: row.dataset.topic,
      description: (row.querySelector('.topic-desc-edit')?.value || row.querySelector('.topic-desc-text')?.textContent || '').trim()
    })).filter(t => t.topic);

    // A2A-41: collect goals from row elements. IMPORTANT: use 'topic' key (NOT
    // 'objective') because parseTopicObjects() in dashboard.js:160 only reads
    // entry.topic. The semantic distinction 'objective' vs 'topic' is UI-only;
    // the storage layer uses {topic, description} uniformly for both.
    const goalRows = document.querySelectorAll('#tier-goals-list .topic-row[data-topic]');
    const goals = Array.from(goalRows).map(row => row.dataset.topic).filter(Boolean);
    const manifestObjectives = Array.from(goalRows).map(row => ({
      topic: row.dataset.topic,
      description: (row.querySelector('.topic-desc-edit')?.value || row.querySelector('.topic-desc-text')?.textContent || '').trim()
    })).filter(g => g.topic);

    const body = {
      name: document.getElementById('tier-name').value,
      description: document.getElementById('tier-description').value,
      allowed_tools,
      topics,
      goals,
      manifest: {
        topics: manifestTopics,
        objectives: manifestObjectives
      }
    };
    await request(`/settings/tiers/${encodeURIComponent(tierId)}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    showNotice(`Saved tier "${tierId}"`);
    await loadSettings();
  });

  document.getElementById('copy-tier-btn').addEventListener('click', async () => {
    const toTier = document.getElementById('tier-select').value;
    const fromTier = document.getElementById('copy-from-tier').value;
    if (!toTier || !fromTier || toTier === fromTier) return;
    await request(`/settings/tiers/${encodeURIComponent(toTier)}/copy-from/${encodeURIComponent(fromTier)}`, {
      method: 'POST'
    });
    showNotice(`Copied "${fromTier}" -> "${toTier}"`);
    await loadSettings();
    renderTierEditor(toTier);
  });

  document.getElementById('defaults-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await request('/settings/defaults', {
      method: 'PUT',
      body: JSON.stringify({
        expiration: document.getElementById('defaults-expiration').value,
        maxCalls: Number.parseInt(document.getElementById('defaults-max-calls').value, 10) || 100
      })
    });
    showNotice('Saved defaults');
    await loadSettings();
  });

  document.getElementById('new-tier-btn').addEventListener('click', () => {
    document.getElementById('new-tier-id').focus();
  });

  document.getElementById('new-tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tierId = document.getElementById('new-tier-id').value.trim();
    const name = document.getElementById('new-tier-name').value.trim();
    const copyFrom = document.getElementById('new-tier-copy-from').value;
    if (!tierId) return;
    await request('/settings/tiers', {
      method: 'POST',
      body: JSON.stringify({
        id: tierId,
        name: name || tierId,
        copy_from: copyFrom || undefined
      })
    });
    showNotice(`Created tier "${tierId}"`);
    document.getElementById('new-tier-form').reset();
    await loadSettings();
    document.getElementById('tier-select').value = tierId;
    renderTierEditor(tierId);
  });

  // A2A-41: toggle for three-column tier view
  document.getElementById('show-drag-columns')?.addEventListener('sl-change', () => {
    renderTierColumns();
  });

  document.getElementById('preview-caller-btn')?.addEventListener('click', openCallerPreview);
  document.getElementById('preview-close-btn')?.addEventListener('click', () => {
    document.getElementById('preview-dialog').hide();
  });
}

async function loadSettings() {
  const payload = await request('/settings');
  state.settings = payload;
  fillTierSelects();
  renderTierColumns();
  document.getElementById('defaults-expiration').value = payload.defaults?.expiration || '7d';
  document.getElementById('defaults-max-calls').value = payload.defaults?.maxCalls || 100;
}

function renderCallbookStatus() {
  const el = document.getElementById('callbook-status');
  if (!el) return;

  const s = state.dashboardStatus;
  if (!s) {
    el.textContent = 'Loading\u2026';
    return;
  }

  const warnings = Array.isArray(s.warnings) ? s.warnings : [];
  const publicUrl = s.public_dashboard_url || '-';
  const enabled = Boolean(s.callbook && s.callbook.enabled);
  const deviceCount = s.callbook && Number.isFinite(s.callbook.device_count) ? s.callbook.device_count : 0;
  const invite = s.invite_host || null;
  const inviteSource = invite && invite.source ? invite.source : null;
  const inviteResolved = invite && invite.host ? invite.host : null;
  const ext = s.external_ip || null;
  const extAttempts = ext && Array.isArray(ext.attempts) ? ext.attempts : [];
  const extMeta = [];
  if (ext && ext.source) extMeta.push(ext.source);
  if (ext && ext.checked_at) extMeta.push(`checked ${fmtDate(ext.checked_at)}`);
  if (ext && ext.from_cache) extMeta.push('cache');
  if (ext && ext.stale) extMeta.push('stale');
  const extMetaText = extMeta.length ? ` <span class="mono">(${esc(extMeta.join(', '))})</span>` : '';
  const extErrorText = ext && ext.error ? esc(ext.error) : '';
  const extAttemptsHtml = extAttempts.length
    ? `<sl-details summary="External IP probe" style="margin-top:0.5rem;">
        <div class="mono" style="margin-top:0.35rem;">
          ${extAttempts.map(a => {
            const service = a && a.service ? String(a.service) : '-';
            const ok = Boolean(a && a.ok);
            const status = a && a.statusCode ? ` (${a.statusCode})` : '';
            const err = a && a.error ? ` (${a.error})` : '';
            return esc(`${service}: ${ok ? 'ok' + status : 'failed' + err}`);
          }).join('<br>')}
        </div>
      </sl-details>`
    : '';

  el.innerHTML = `
    <div><strong>Public dashboard URL:</strong> <span class="mono">${esc(publicUrl)}</span></div>
    <div><strong>Invite host:</strong> <span class="mono">${esc(inviteResolved || '-')}</span>${inviteSource ? ` <span class="mono">(${esc(inviteSource)})</span>` : ''}</div>
    <div><strong>External IP (egress):</strong> <span class="mono">${esc((ext && ext.ip) ? ext.ip : '-')}</span>${extMetaText}</div>
    ${extErrorText ? `<div style="margin-top:0.35rem;"><strong>External IP error:</strong> <span class="mono">${extErrorText}</span></div>` : ''}
    ${extAttemptsHtml}
    <div><strong>Callbook session storage:</strong> ${enabled ? 'enabled' : 'disabled'}</div>
    <div><strong>Paired devices:</strong> ${deviceCount}</div>
    ${warnings.length ? `<div style="margin-top:0.5rem;"><strong>Warnings:</strong><br>${warnings.map(w => esc(w)).join('<br>')}</div>` : ''}
  `;
}

function renderAutoUpdateStatus() {
  const el = document.getElementById('auto-update-status');
  const toggleBtn = document.getElementById('auto-update-toggle');
  if (!el) return;

  const au = state.autoUpdate;
  if (!au) {
    el.textContent = 'Loading\u2026';
    if (toggleBtn) toggleBtn.disabled = true;
    return;
  }

  const stateText = formatUpdaterState(au.state);
  const variant = badgeVariant(au.state);
  const enabled = Boolean(au.enabled);
  const intervalSec = Number.isFinite(au.interval_ms) ? Math.floor(au.interval_ms / 1000) : null;

  el.innerHTML = `
    <div><strong>Status:</strong> <sl-badge variant="${variant}">${esc(stateText)}</sl-badge></div>
    <div><strong>Enabled:</strong> ${enabled ? 'yes' : 'no'}</div>
    <div><strong>Current version:</strong> <span class="mono">${esc(au.current_version || '-')}</span></div>
    <div><strong>Latest version:</strong> <span class="mono">${esc(au.latest_version || '-')}</span></div>
    <div><strong>Target version:</strong> <span class="mono">${esc(au.target_version || '-')}</span></div>
    <div><strong>Active calls:</strong> ${esc(String(au.active_calls || 0))}</div>
    <div><strong>Interval:</strong> ${intervalSec === null ? '-' : `${intervalSec}s`}</div>
    <div><strong>Last checked:</strong> ${esc(fmtDate(au.last_checked_at))}</div>
    <div><strong>Last success:</strong> ${esc(fmtDate(au.last_success_at))}</div>
    ${au.defer_reason ? `<div><strong>Deferred:</strong> ${esc(au.defer_reason)}</div>` : ''}
    ${au.last_error ? `<div><strong>Error:</strong> <span class="mono">${esc(au.last_error)}</span></div>` : ''}
  `;

  if (toggleBtn) {
    toggleBtn.disabled = false;
    toggleBtn.textContent = enabled ? 'Disable auto-update' : 'Enable auto-update';
  }
}

async function loadDashboardStatus(refreshIp = false) {
  const payload = await request(`/status${refreshIp ? '?refresh_ip=true' : ''}`);
  state.dashboardStatus = payload;
  state.autoUpdate = payload.auto_update || state.autoUpdate;
  renderCallbookStatus();
  renderAutoUpdateStatus();
  renderContacts();
  renderContactDetail();
}

async function loadAutoUpdateStatus() {
  const payload = await request('/update/status');
  state.autoUpdate = payload.auto_update || null;
  renderAutoUpdateStatus();
}

function renderCallbookDevices() {
  const tbody = document.querySelector('#callbook-devices-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const devices = Array.isArray(state.callbookDevices) ? state.callbookDevices : [];
  if (devices.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6">No devices found.</td>';
    tbody.appendChild(tr);
    return;
  }

  devices.forEach(dev => {
    const tr = document.createElement('tr');
    const revoked = Boolean(dev.revoked_at);
    const sessions = dev.active_sessions ?? '-';
    tr.innerHTML = `
      <td>${esc(dev.label || dev.id || '-')}</td>
      <td>${esc(fmtDate(dev.created_at))}</td>
      <td>${esc(fmtDate(dev.last_used_at))}</td>
      <td>${esc(String(sessions))}</td>
      <td>${revoked ? esc(fmtDate(dev.revoked_at)) : '-'}</td>
      <td>
        <sl-button size="small" variant="danger" data-revoke="${esc(dev.id)}" ${revoked ? 'disabled' : ''}>Revoke</sl-button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-revoke]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const deviceId = btn.dataset.revoke;
      if (!deviceId) return;
      btn.disabled = true;
      try {
        await request(`/callbook/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' });
        showNotice('Device revoked');
        await loadCallbookDevices();
      } catch (err) {
        showNotice(err.message);
        btn.disabled = false;
      }
    });
  });
}

async function loadCallbookDevices() {
  const payload = await request('/callbook/devices?include_revoked=true');
  state.callbookDevices = payload.devices || [];
  renderCallbookDevices();
}

function bindCallbookActions() {
  const form = document.getElementById('callbook-provision-form');
  if (!form) return;

  const urlEl = document.getElementById('callbook-install-url');
  const labelEl = document.getElementById('callbook-label');
  const warningsEl = document.getElementById('callbook-warnings');

  document.getElementById('callbook-logout')?.addEventListener('click', async () => {
    try {
      await request('/callbook/logout', { method: 'POST' });
      showNotice('Logged out (cookie cleared)');
    } catch (err) {
      showNotice(err.message);
    }
  });

  document.getElementById('callbook-copy-url')?.addEventListener('click', async () => {
    const ok = await copyText(urlEl?.value || '');
    showNotice(ok ? 'Copied' : 'Copy failed');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (warningsEl) warningsEl.textContent = '';
    if (urlEl) urlEl.value = '';

    const body = {
      label: labelEl ? labelEl.value : 'Callbook Remote',
      ttl_hours: 24
    };

    try {
      const result = await request('/callbook/provision', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (urlEl) urlEl.value = result.install_url || '';
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      const expiresAt = result.expires_at ? `Expires: ${fmtDate(result.expires_at)}` : '';
      if (warningsEl) {
        warningsEl.textContent = [expiresAt, ...warnings].filter(Boolean).join('\n');
      }
      showNotice('Install link created');
    } catch (err) {
      showNotice(err.message);
    }
  });
}

function bindAutoUpdateActions() {
  document.getElementById('auto-update-check')?.addEventListener('click', async () => {
    try {
      await request('/update/check', { method: 'POST', body: JSON.stringify({}) });
      await loadAutoUpdateStatus();
      showNotice('Update check complete');
    } catch (err) {
      showNotice(err.message);
    }
  });

  document.getElementById('auto-update-now')?.addEventListener('click', async () => {
    try {
      await request('/update/now', { method: 'POST', body: JSON.stringify({}) });
      await loadAutoUpdateStatus();
      showNotice('Update triggered');
    } catch (err) {
      showNotice(err.message);
    }
  });

  document.getElementById('auto-update-toggle')?.addEventListener('click', async () => {
    const au = state.autoUpdate || {};
    const nextEnabled = !Boolean(au.enabled);
    try {
      await request('/update/config', {
        method: 'PUT',
        body: JSON.stringify({ enabled: nextEnabled })
      });
      await loadAutoUpdateStatus();
      showNotice(nextEnabled ? 'Auto-update enabled' : 'Auto-update disabled');
    } catch (err) {
      showNotice(err.message);
    }
  });
}

function renderInvites() {
  const tbody = document.querySelector('#invites-table tbody');
  tbody.innerHTML = '';
  state.invites.forEach(invite => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${invite.id}</td>
      <td>${invite.name || '-'}</td>
      <td>${invite.tier || '-'}</td>
      <td>${invite.calls_made || 0}${invite.max_calls ? `/${invite.max_calls}` : ''}</td>
      <td>${fmtDate(invite.expires_at)}</td>
      <td><sl-badge variant="${invite.revoked ? 'danger' : 'success'}">${invite.revoked ? 'revoked' : 'active'}</sl-badge></td>
      <td><sl-button size="small" variant="danger" data-revoke="${invite.id}" ${invite.revoked ? 'disabled' : ''}>Revoke</sl-button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-revoke]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tokenId = btn.dataset.revoke;
      await request(`/invites/${encodeURIComponent(tokenId)}/revoke`, { method: 'POST' });
      showNotice(`Revoked ${tokenId}`);
      await loadInvites();
    });
  });
}

async function loadInvites() {
  const payload = await request('/invites?include_revoked=true');
  state.invites = payload.invites || [];
  renderInvites();
}

function bindInviteActions() {
  const cancelBtn = document.getElementById('generate-invite-cancel');
  const inviteDetails = document.getElementById('generate-invite-details');
  const inviteMessageWrap = document.getElementById('invite-message-wrap');
  const inviteMessage = document.getElementById('invite-message');

  // Cancel button collapses the sl-details
  if (cancelBtn && inviteDetails) {
    cancelBtn.addEventListener('click', () => {
      inviteDetails.open = false;
    });
  }

  document.getElementById('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: document.getElementById('invite-name').value,
      owner: document.getElementById('invite-owner').value,
      tier: document.getElementById('invite-tier').value,
      expires: document.getElementById('invite-expires').value,
      max_calls: Number.parseInt(document.getElementById('invite-max-calls').value, 10),
      notify: document.getElementById('invite-notify').value
    };
    const result = await request('/invites', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    // Show the invite message textarea with the result
    if (inviteMessage) {
      inviteMessage.value = result.invite_message || result.invite_url;
      if (inviteMessageWrap) inviteMessageWrap.style.display = 'block';
    }
    // Collapse the details after successful creation
    if (inviteDetails) inviteDetails.open = false;
    if (result.warnings && result.warnings.length) {
      showNotice(result.warnings[0]);
    } else {
      showNotice('Invite created');
    }
    await loadInvites();
  });
}

function bindLogFilterRefresh() {
  // Auto-refresh logs as filters change (debounced).
  let debounce = null;
  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => loadLogs().catch(err => showNotice(err.message)), 250);
  };
  [
    'logs-level',
    'logs-component',
    'logs-event',
    'logs-trace',
    'logs-conversation',
    'logs-token',
    'logs-search',
    'logs-limit'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    // Shoelace components fire sl-input and sl-change events
    el.addEventListener('sl-input', schedule);
    el.addEventListener('sl-change', schedule);
    // Also listen for native events as fallback
    el.addEventListener('input', schedule);
    el.addEventListener('change', schedule);
  });
}

// --- Smart tab polling ---

let pollTimer = null;

// A2A-47: Simply return tracked state instead of querying sl-tab-group
function getActiveTab() {
  return state.activeTab || 'contacts';
}

const tabLoaders = {
  contacts: loadContacts,
  calls: loadCalls,
  logs: () => { loadLogs(); loadLogStats(); },
  permissions: () => {},
  invites: loadInvites,
  health: loadHealth,
};

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    const loader = tabLoaders[getActiveTab()];
    if (loader) loader().catch(() => {});
  }, 5000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function onTabSwitch(tabName) {
  const loader = tabLoaders[tabName];
  if (loader) {
    try { loader().catch(() => {}); } catch (_) {}
  }
  startPolling(); // reset the 5s timer
}

// === Health Tab (A2A-42) ===

// A2A-42: Escape HTML entities for safe innerHTML rendering of step names/errors.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadHealth() {
  try {
    const data = await request('/test-results');
    renderHealthLatest(data.latest);
    renderHealthHistory(data.history || []);
  } catch (err) {
    renderHealthLatest(null);
    renderHealthHistory([]);
  }
}

function renderHealthLatest(latest) {
  const card = document.getElementById('health-latest');
  if (!card) return;

  if (!latest) {
    card.innerHTML = '<p>No test results available. Run <code>node test/e2e/orchestrate.js --persist</code> to generate.</p>';
    return;
  }

  const statusBadge = latest.status === 'passed'
    ? '<sl-badge variant="success">PASSED</sl-badge>'
    : '<sl-badge variant="danger">FAILED</sl-badge>';

  const regression = latest.regression;
  let regressionHtml = '';
  if (regression && regression.detected) {
    regressionHtml = `<p><sl-badge variant="warning">REGRESSION</sl-badge> New failures: ${regression.newFailures.map(escapeHtml).join(', ')}</p>`;
  }
  if (regression && regression.fixedTests && regression.fixedTests.length > 0) {
    regressionHtml += `<p><sl-badge variant="success">FIXED</sl-badge> ${regression.fixedTests.map(escapeHtml).join(', ')}</p>`;
  }

  const ts = latest.finishedAt ? new Date(latest.finishedAt).toLocaleString() : 'unknown';
  const summary = latest.summary || {};

  card.innerHTML = `
    <div class="row">
      <strong>Latest Run</strong> ${statusBadge}
    </div>
    <p><strong>Duration:</strong> ${latest.duration || 0}ms &middot;
       <strong>Passed:</strong> ${summary.passed || 0} &middot;
       <strong>Failed:</strong> ${summary.failed || 0} &middot;
       <strong>Skipped:</strong> ${summary.skipped || 0} &middot;
       <strong>Time:</strong> ${ts}</p>
    ${regressionHtml}
    <details>
      <summary>Steps (${(latest.steps || []).length})</summary>
      <ul>
        ${(latest.steps || []).map(s => {
          const icon = s.status === 'pass' ? '&#x2705;' : s.status === 'fail' ? '&#x274C;' : '&#x23ED;';
          const err = s.error ? ` — <code>${escapeHtml(String(s.error).slice(0, 120))}</code>` : '';
          return `<li>${icon} ${escapeHtml(s.name)}${err}</li>`;
        }).join('')}
      </ul>
    </details>
  `;
}

function renderHealthHistory(history) {
  const tbody = document.querySelector('#health-history-table tbody');
  if (!tbody) return;

  if (!history || history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6">No history</td></tr>';
    return;
  }

  tbody.innerHTML = history.map(r => {
    const badge = r.status === 'passed'
      ? '<sl-badge variant="success" size="small">PASS</sl-badge>'
      : '<sl-badge variant="danger" size="small">FAIL</sl-badge>';
    const summary = r.summary || {};
    const regression = r.regression;
    const regText = regression && regression.detected
      ? `<sl-badge variant="warning" size="small">${regression.newFailures.length} new</sl-badge>`
      : '-';
    const ts = r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '-';
    return `<tr>
      <td>${badge}</td>
      <td>${r.duration || 0}ms</td>
      <td>${summary.passed || 0}</td>
      <td>${summary.failed || 0}</td>
      <td>${regText}</td>
      <td>${ts}</td>
    </tr>`;
  }).join('');
}

async function bootstrap() {
  bindTabs();
  bindContactsActions();
  bindSettingsActions();
  bindItemListDelegation();
  bindCallbookActions();
  bindAutoUpdateActions();
  bindInviteActions();
  bindLogFilterRefresh();

  try {
    await Promise.all([
      loadSettings(),
      loadDashboardStatus(),
      loadAutoUpdateStatus(),
      loadCallbookDevices(),
      loadContacts(),
      loadCalls(),
      loadInvites(),
      loadLogStats(),
      loadLogs()
    ]);
    showNotice('Dashboard loaded');
    connectRealtimeEvents();
    startPolling();

    setInterval(() => {
      loadAutoUpdateStatus().catch(() => {});
    }, 10000);
  } catch (err) {
    showNotice(err.message);
  }
}

bootstrap();
