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
  activeTab: 'contacts',
  // A2A-48: Track currently selected tier for the permissions panel.
  // Replaces the old #tier-select dropdown value.
  activeTierId: 'public'
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
        <td><span class="contact-status" data-status="${esc(c?.status || 'unknown')}">${esc(c?.status || '-')}</span></td>
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
      <td><span class="log-level" data-level="${esc(row.level || '')}">${esc(row.level || '-')}</span></td>
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

// A2A-48: Material icon mapping for tier cards. Standard tiers get recognizable
// icons; custom tiers get a wrench icon. Used by renderTierCards().
const TIER_ICONS = { public: 'public', friends: 'group', family: 'family_restroom' };

// A2A-48: Color mapping for tool icons in toggle cards. Gives each tool a
// distinct color matching the concept mock's visual differentiation.
const TOOL_ICON_MAP = {
  'Bash': { icon: 'terminal', bg: 'rgba(99,102,241,0.2)', color: '#818CF8', border: 'rgba(99,102,241,0.2)' },
  'Bash(readonly)': { icon: 'terminal', bg: 'rgba(99,102,241,0.15)', color: '#A5B4FC', border: 'rgba(99,102,241,0.15)' },
  'Read': { icon: 'visibility', bg: 'rgba(59,130,246,0.2)', color: '#60A5FA', border: 'rgba(59,130,246,0.2)' },
  'Grep': { icon: 'search', bg: 'rgba(139,92,246,0.2)', color: '#A78BFA', border: 'rgba(139,92,246,0.2)' },
  'Glob': { icon: 'folder_open', bg: 'rgba(16,185,129,0.2)', color: '#34D399', border: 'rgba(16,185,129,0.2)' },
  'WebSearch': { icon: 'public', bg: 'rgba(245,158,11,0.2)', color: '#FBBF24', border: 'rgba(245,158,11,0.2)' },
  'WebFetch': { icon: 'language', bg: 'rgba(236,72,153,0.2)', color: '#F472B6', border: 'rgba(236,72,153,0.2)' }
};

// A2A-48: Renders tier cards grid. Active card gets .active class with glow.
function renderTierCards() {
  const container = document.getElementById('tier-cards');
  if (!container) return;
  const tiers = (state.settings?.tiers || []).slice().sort((a, b) => {
    const aIdx = TIER_ORDER.indexOf(a.id);
    const bIdx = TIER_ORDER.indexOf(b.id);
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return a.id.localeCompare(b.id);
  });

  container.innerHTML = tiers.map(tier => {
    const isActive = tier.id === state.activeTierId;
    const icon = TIER_ICONS[tier.id] || 'build';
    const iconColor = isActive ? '#60A5FA' : '#6B7280';
    return `
      <div class="tier-card${isActive ? ' active' : ''}" data-tier-id="${esc(tier.id)}">
        <span class="material-symbols-outlined tier-card-icon" style="color:${iconColor};">${icon}</span>
        <span class="tier-card-name">${esc(tier.name || tier.id)}</span>
        ${isActive ? '<div class="status-dot status-dot--green"></div>' : ''}
      </div>
    `;
  }).join('');
}

// A2A-48: Renders tool toggle cards (replaces checkboxes). Each tool is a
// glass-panel card with icon, name, description, and a toggle switch.
// Toggle change triggers autoSaveTier() for immediate persistence.
function renderToolToggles(allowedTools) {
  const container = document.getElementById('tool-toggles');
  if (!container) return;
  container.innerHTML = Object.entries(TOOL_DESCRIPTIONS).map(([tool, desc]) => {
    const checked = (allowedTools || []).includes(tool);
    const iconInfo = TOOL_ICON_MAP[tool] || { icon: 'extension', bg: 'rgba(100,116,139,0.2)', color: '#94A3B8', border: 'rgba(100,116,139,0.2)' };
    return `
      <div class="tool-toggle-card${checked ? ' enabled' : ''}">
        <div class="tool-toggle-info">
          <div class="tool-icon" style="background:${iconInfo.bg};color:${iconInfo.color};border:1px solid ${iconInfo.border};">
            <span class="material-symbols-outlined">${iconInfo.icon}</span>
          </div>
          <div>
            <h3>${esc(tool)}</h3>
            <p>${esc(desc)}</p>
          </div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" data-tool="${esc(tool)}" ${checked ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    `;
  }).join('');
}

// A2A-48: Renders active topics in the drop zone as teal-accented cards.
// Each card has a close button for removal. Updates #topic-count badge.
function renderActiveTopics(tier) {
  const container = document.getElementById('active-topics-zone');
  if (!container) return;
  const manifestTopics = tier.manifest?.topics || [];
  const flatTopics = tier.topics || [];

  const allTopics = manifestTopics.length > 0
    ? manifestTopics.map(t => ({ label: t.topic, desc: t.description || '' }))
    : flatTopics.map(t => ({ label: t, desc: '' }));

  const cardsHtml = allTopics.map(t => `
    <div class="active-item-card active-item-card--teal" data-topic="${esc(t.label)}" data-description="${esc(t.desc)}">
      <div>
        <div class="item-name">${esc(t.label)}</div>
        <div class="item-type-label">Topic</div>
      </div>
      <button class="item-close-btn" data-remove-topic="${esc(t.label)}">
        <span class="material-symbols-outlined" style="font-size:16px;">close</span>
      </button>
    </div>
  `).join('');

  container.innerHTML = cardsHtml + '<div class="drop-placeholder"><span>+ Drop Topic</span></div>';

  const badge = document.getElementById('topic-count');
  if (badge) badge.textContent = `${allTopics.length} Active`;
}

// A2A-48: Renders active goals in the drop zone as yellow-accented cards.
// Same pattern as topics but with yellow color variant.
function renderActiveGoals(tier) {
  const container = document.getElementById('active-goals-zone');
  if (!container) return;
  const manifestGoals = tier.manifest?.objectives || [];
  const flatGoals = tier.goals || [];

  const allGoals = manifestGoals.length > 0
    ? manifestGoals.map(g => ({ label: g.objective || g.topic, desc: g.description || '' }))
    : flatGoals.map(g => ({ label: g, desc: '' }));

  const cardsHtml = allGoals.map(g => `
    <div class="active-item-card active-item-card--yellow" data-topic="${esc(g.label)}" data-description="${esc(g.desc)}">
      <div>
        <div class="item-name">${esc(g.label)}</div>
        <div class="item-type-label">Goal</div>
      </div>
      <button class="item-close-btn" data-remove-goal="${esc(g.label)}">
        <span class="material-symbols-outlined" style="font-size:16px;">close</span>
      </button>
    </div>
  `).join('');

  container.innerHTML = cardsHtml + '<div class="drop-placeholder"><span>+ Drop Goal</span></div>';

  const badge = document.getElementById('goal-count');
  if (badge) badge.textContent = `${allGoals.length} Active`;
}

// A2A-48: Orchestrator that renders the entire permissions panel.
// Uses state.activeTierId instead of reading a dropdown value.
function renderPermissions() {
  const tier = (state.settings?.tiers || []).find(t => t.id === state.activeTierId);
  if (!tier) return;
  renderTierCards();
  renderActiveTopics(tier);
  renderActiveGoals(tier);
  renderToolToggles(tier.allowed_tools);
  renderTierWarnings(tier);
  renderSidebarPreview(state.activeTierId);
  renderSidebarLists(tier);
  bindSidebarDrag();
}

// A2A-48: Renders the inline "Preview as Caller" card in the right sidebar.
// Reuses getPreviewData() to show merged topics, goals, and tool count.
function renderSidebarPreview(tierId) {
  const container = document.getElementById('perm-preview');
  if (!container) return;
  const data = getPreviewData(tierId);
  const tierName = (state.settings?.tiers || []).find(t => t.id === tierId)?.name || tierId;
  const topicNames = data.topics.map(t => t.topic).filter(Boolean);
  const goalNames = data.objectives.map(g => g.objective || g.topic).filter(Boolean);
  const toolCount = data.tools.size;

  const topicText = topicNames.length > 0 ? `<strong style="color:#2DD4BF;">${esc(topicNames.join(', '))}</strong>` : '<em>no topics</em>';
  const goalText = goalNames.length > 0 ? `<strong style="color:#FBBF24;">${esc(goalNames.join(', '))}</strong>` : '<em>no goals</em>';

  container.innerHTML = `
    <div class="preview-card-inner">
      <div class="sidebar-list-header">Preview as Caller</div>
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
        <span class="material-symbols-outlined" style="color:#60A5FA;">smart_toy</span>
        <div>
          <div style="font-weight:600;font-size:0.85rem;color:var(--ink);">Agent Permission</div>
          <span class="preview-tier-badge">${esc(tierName)} Tier</span>
        </div>
      </div>
      <div class="preview-summary">
        This agent can discuss ${topicText} to help ${goalText} using <strong>${toolCount} tool${toolCount !== 1 ? 's' : ''}</strong>.
      </div>
      <div class="preview-footer">
        <span style="display:flex;align-items:center;gap:0.3rem;">
          <span class="status-dot status-dot--green"></span> Active
        </span>
        <span style="font-family:monospace;opacity:0.7;">JSON Valid</span>
      </div>
    </div>
  `;
}

// A2A-48: Renders all topics and goals in the right sidebar as draggable items.
// Items active in the current tier are dimmed with an "(Active)" label.
function renderSidebarLists(tier) {
  const topicContainer = document.getElementById('sidebar-topics');
  const goalContainer = document.getElementById('sidebar-goals');
  if (!topicContainer || !goalContainer) return;

  // Collect ALL topics across ALL tiers for the sidebar
  const allTiers = state.settings?.tiers || [];
  const allTopicMap = new Map();
  const allGoalMap = new Map();
  for (const t of allTiers) {
    const mTopics = t.manifest?.topics || [];
    const fTopics = t.topics || [];
    const topics = mTopics.length > 0 ? mTopics : fTopics.map(x => ({ topic: x, description: '' }));
    for (const item of topics) {
      if (item.topic && !allTopicMap.has(item.topic)) {
        allTopicMap.set(item.topic, item.description || '');
      }
    }
    const mGoals = t.manifest?.objectives || [];
    const fGoals = t.goals || [];
    const goals = mGoals.length > 0 ? mGoals : fGoals.map(x => ({ topic: x, description: '' }));
    for (const item of goals) {
      const label = item.objective || item.topic;
      if (label && !allGoalMap.has(label)) {
        allGoalMap.set(label, item.description || '');
      }
    }
  }

  // Determine which are active in the current tier
  const activeTopicSet = new Set((tier.topics || []).concat(
    (tier.manifest?.topics || []).map(t => t.topic)
  ).filter(Boolean));
  const activeGoalSet = new Set((tier.goals || []).concat(
    (tier.manifest?.objectives || []).map(g => g.objective || g.topic)
  ).filter(Boolean));

  // Render topics sidebar
  const topicItems = Array.from(allTopicMap.entries()).map(([name, desc]) => {
    const isActive = activeTopicSet.has(name);
    return `
      <div class="sidebar-item${isActive ? ' active-in-zone' : ''}" draggable="${isActive ? 'false' : 'true'}" data-sidebar-topic="${esc(name)}" data-description="${esc(desc)}" data-item-type="topic">
        <div style="display:flex;align-items:center;gap:0.4rem;">
          ${isActive ? '' : '<span class="material-symbols-outlined" style="color:#4B5563;font-size:1rem;cursor:grab;">drag_indicator</span>'}
          <span class="sidebar-item-name">${esc(name)}${isActive ? ' <span class="sidebar-item-active-label">(Active)</span>' : ''}</span>
        </div>
      </div>
    `;
  }).join('');

  topicContainer.innerHTML = `
    <div class="sidebar-list-header">Topics</div>
    ${topicItems}
    <button class="sidebar-add-btn" data-add-type="topic">
      <span class="material-symbols-outlined" style="font-size:14px;">add</span> Add Topic
    </button>
  `;

  // Render goals sidebar
  const goalItems = Array.from(allGoalMap.entries()).map(([name, desc]) => {
    const isActive = activeGoalSet.has(name);
    return `
      <div class="sidebar-item${isActive ? ' active-in-zone' : ''}" draggable="${isActive ? 'false' : 'true'}" data-sidebar-goal="${esc(name)}" data-description="${esc(desc)}" data-item-type="goal">
        <div style="display:flex;align-items:center;gap:0.4rem;">
          ${isActive ? '' : '<span class="material-symbols-outlined" style="color:#4B5563;font-size:1rem;cursor:grab;">drag_indicator</span>'}
          <span class="sidebar-item-name">${esc(name)}${isActive ? ' <span class="sidebar-item-active-label">(Active)</span>' : ''}</span>
        </div>
      </div>
    `;
  }).join('');

  goalContainer.innerHTML = `
    <div class="sidebar-list-header">Goals &amp; Objectives</div>
    ${goalItems}
    <button class="sidebar-add-btn" data-add-type="goal">
      <span class="material-symbols-outlined" style="font-size:14px;">add</span> Add Goal
    </button>
  `;
}

// A2A-48: Debounced auto-save replaces explicit Save Tier button.
// 250ms delay prevents excessive API calls during rapid changes.
let _autoSaveTimer = null;
function autoSaveTier() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    const tierId = state.activeTierId;
    if (!tierId) return;

    // Collect tools from toggle states
    const toggles = document.querySelectorAll('#tool-toggles .toggle-switch input');
    const allowed_tools = Array.from(toggles).filter(t => t.checked).map(t => t.dataset.tool);

    // Collect topics from active zone
    const topicCards = document.querySelectorAll('#active-topics-zone .active-item-card');
    // A2A-48: uses dataset.topic for BOTH topics and goals (NOT dataset.objective)
    // because parseTopicObjects() in dashboard.js:160 only reads entry.topic.
    // The semantic distinction (objective vs topic) is UI-only; storage layer
    // uses {topic, description} uniformly for both types.
    const topics = Array.from(topicCards).map(c => c.dataset.topic).filter(Boolean);
    const manifestTopics = Array.from(topicCards).map(c => ({
      topic: c.dataset.topic,
      description: c.dataset.description || ''
    })).filter(t => t.topic);

    // Collect goals from active zone
    const goalCards = document.querySelectorAll('#active-goals-zone .active-item-card');
    const goals = Array.from(goalCards).map(c => c.dataset.topic).filter(Boolean);
    const manifestObjectives = Array.from(goalCards).map(c => ({
      topic: c.dataset.topic,
      description: c.dataset.description || ''
    })).filter(g => g.topic);

    const body = { allowed_tools, topics, goals, manifest: { topics: manifestTopics, objectives: manifestObjectives } };
    // A2A-48: Refresh state inside try block so that a failed PUT does not
    // trigger an unhandled rejection from the subsequent GET.
    try {
      await request(`/settings/tiers/${encodeURIComponent(tierId)}`, {
        method: 'PUT', body: JSON.stringify(body)
      });
      showNotice('Saved');
      // Refresh state from server to stay in sync after auto-save
      const payload = await request('/settings');
      state.settings = payload;
    } catch (err) {
      showNotice(`Save failed: ${err.message}`);
    }
  }, 250);
}

// A2A-48: Binds dragstart/dragend on sidebar items (re-created each render).
// Zone listeners (dragover/dragleave/drop) are bound ONCE in
// bindPermissionsActions() to avoid listener accumulation — the zone
// containers persist across renders while only their innerHTML changes.
function bindSidebarDrag() {
  document.querySelectorAll('.sidebar-item[draggable="true"]').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      const itemType = item.dataset.itemType || 'topic';
      const name = item.dataset.sidebarTopic || item.dataset.sidebarGoal || '';
      const desc = item.dataset.description || '';
      e.dataTransfer.setData('application/json', JSON.stringify({ name, description: desc, type: itemType }));
      item.style.opacity = '0.5';
    });
    item.addEventListener('dragend', () => { item.style.opacity = ''; });
  });
}

// A2A-48: Drop handler for active topic/goal zones. Extracted from
// bindSidebarDrag() to be called once in bindPermissionsActions().
function handleZoneDrop(zone, e) {
  e.preventDefault();
  zone.classList.remove('drag-over');
  let data;
  try { data = JSON.parse(e.dataTransfer.getData('application/json')); } catch { return; }
  if (!data.name) return;

  const isTopicZone = zone.id === 'active-topics-zone';
  const accentClass = isTopicZone ? 'active-item-card--teal' : 'active-item-card--yellow';
  const typeLabel = isTopicZone ? 'Topic' : 'Goal';
  const removeAttr = isTopicZone ? 'data-remove-topic' : 'data-remove-goal';

  // Check if already in zone
  const existing = zone.querySelectorAll('.active-item-card');
  for (const card of existing) {
    if (card.dataset.topic === data.name) return; // already active
  }

  // Insert before the placeholder
  const placeholder = zone.querySelector('.drop-placeholder');
  const card = document.createElement('div');
  card.className = `active-item-card ${accentClass}`;
  card.dataset.topic = data.name;
  card.dataset.description = data.description || '';
  card.innerHTML = `
    <div>
      <div class="item-name">${esc(data.name)}</div>
      <div class="item-type-label">${typeLabel}</div>
    </div>
    <button class="item-close-btn" ${removeAttr}="${esc(data.name)}">
      <span class="material-symbols-outlined" style="font-size:16px;">close</span>
    </button>
  `;
  zone.insertBefore(card, placeholder);
  autoSaveTier();

  // A2A-48: Re-fetch tier from state instead of using captured reference,
  // since autoSaveTier() may refresh state.settings asynchronously.
  setTimeout(() => {
    const freshTier = (state.settings?.tiers || []).find(t => t.id === state.activeTierId);
    if (freshTier) renderSidebarLists(freshTier);
  }, 300);
}

// A2A-48: Extracted from old fillTierSelects(). Populates only the
// #invite-tier (Invites tab) and #new-tier-copy-from (Settings details).
// Does NOT populate the removed #tier-select or #copy-from-tier.
function populateInviteTierSelect() {
  const tiers = (state.settings?.tiers || []).slice().sort((a, b) => a.id.localeCompare(b.id));
  const newTierCopy = document.getElementById('new-tier-copy-from');
  const inviteTier = document.getElementById('invite-tier');

  const optionsHtml = tiers.map(tier => {
    const emoji = TIER_EMOJIS[tier.id] || '\u{1F527}';
    return `<sl-option value="${esc(tier.id)}">${emoji} ${esc(tier.name || tier.id)}</sl-option>`;
  }).join('');

  if (inviteTier) inviteTier.innerHTML = optionsHtml;
  if (newTierCopy) newTierCopy.innerHTML = `<sl-option value="">None</sl-option>${optionsHtml}`;

  // A2A-48: Default invite tier to 'public'
  const defaultTier = tiers.find(t => t.id === 'public') ? 'public' : tiers[0]?.id;
  if (defaultTier && inviteTier) inviteTier.value = defaultTier;
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

// A2A-48: opens the caller preview dialog showing the merged effective view
// for the selected tier. Uses state.activeTierId instead of removed #tier-select.
function openCallerPreview() {
  const tierId = state.activeTierId;
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

// A2A-48: Binds all event handlers for the permissions panel. Replaces old
// bindSettingsActions() — removes handlers for deleted elements (tier-form,
// tier-select, copy-tier-btn, show-drag-columns, preview-caller-btn) and
// adds handlers for tier cards, tool toggles, close buttons, and sidebar.
function bindPermissionsActions() {
  const panel = document.getElementById('panel-permissions');
  if (!panel) return;

  // A2A-48: Tier card click — switch active tier and re-render.
  // No autoSaveTier() here: switching tiers is a read operation, not a write.
  panel.addEventListener('click', (e) => {
    const card = e.target.closest('.tier-card[data-tier-id]');
    if (card) {
      state.activeTierId = card.dataset.tierId;
      renderPermissions();
      return;
    }

    // A2A-48: Close button on active topic cards
    const removeTopic = e.target.closest('[data-remove-topic]');
    if (removeTopic) {
      const card = removeTopic.closest('.active-item-card');
      if (card) card.remove();
      autoSaveTier();
      return;
    }

    // A2A-48: Close button on active goal cards
    const removeGoal = e.target.closest('[data-remove-goal]');
    if (removeGoal) {
      const card = removeGoal.closest('.active-item-card');
      if (card) card.remove();
      autoSaveTier();
      return;
    }

    // A2A-48: "+ New Tier" button scrolls to the new-tier form inside Settings details
    const newTierBtn = e.target.closest('#perm-new-tier-btn');
    if (newTierBtn) {
      const details = panel.querySelector('sl-details');
      if (details) details.open = true;
      setTimeout(() => {
        const el = document.getElementById('new-tier-id');
        if (el) { el.scrollIntoView({ behavior: 'smooth' }); el.focus(); }
      }, 200);
      return;
    }

    // A2A-48: Sidebar "Add Topic" / "Add Goal" buttons open create dialog
    const addBtn = e.target.closest('.sidebar-add-btn[data-add-type]');
    if (addBtn) {
      const type = addBtn.dataset.addType;
      const dialog = document.getElementById('create-item-dialog');
      if (dialog) {
        dialog.label = `Create New ${type === 'topic' ? 'Topic' : 'Goal'}`;
        dialog.dataset.createType = type;
        const titleInput = document.getElementById('create-item-title');
        const descInput = document.getElementById('create-item-desc');
        if (titleInput) titleInput.value = '';
        if (descInput) descInput.value = '';
        dialog.show();
      }
      return;
    }
  });

  // A2A-48: Drop zone listeners — bound ONCE here because the zone containers
  // (#active-topics-zone, #active-goals-zone) persist across renders. Only
  // their innerHTML is replaced by renderActiveTopics/renderActiveGoals.
  // Binding in bindSidebarDrag() would cause listener accumulation.
  const topicZone = document.getElementById('active-topics-zone');
  const goalZone = document.getElementById('active-goals-zone');
  [topicZone, goalZone].forEach(zone => {
    if (!zone) return;
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => handleZoneDrop(zone, e));
  });

  // A2A-48: Tool toggle change — auto-save and update card styling
  panel.addEventListener('change', (e) => {
    const toggle = e.target.closest('#tool-toggles .toggle-switch input');
    if (toggle) {
      const card = toggle.closest('.tool-toggle-card');
      if (card) {
        card.classList.toggle('enabled', toggle.checked);
      }
      autoSaveTier();
      return;
    }
  });

  // A2A-48: Create Item dialog — submit handler
  document.getElementById('create-item-submit')?.addEventListener('click', () => {
    const dialog = document.getElementById('create-item-dialog');
    const titleInput = document.getElementById('create-item-title');
    const descInput = document.getElementById('create-item-desc');
    if (!dialog || !titleInput) return;

    const title = titleInput.value.trim();
    if (!title) { titleInput.focus(); return; }
    const desc = descInput?.value?.trim() || '';
    const type = dialog.dataset.createType || 'topic';

    // A2A-48: Add item to the appropriate active zone
    const zoneId = type === 'topic' ? 'active-topics-zone' : 'active-goals-zone';
    const zone = document.getElementById(zoneId);
    if (!zone) return;

    const accentClass = type === 'topic' ? 'active-item-card--teal' : 'active-item-card--yellow';
    const typeLabel = type === 'topic' ? 'Topic' : 'Goal';
    const removeAttr = type === 'topic' ? 'data-remove-topic' : 'data-remove-goal';

    const placeholder = zone.querySelector('.drop-placeholder');
    const card = document.createElement('div');
    card.className = `active-item-card ${accentClass}`;
    card.dataset.topic = title;
    card.dataset.description = desc;
    card.innerHTML = `
      <div>
        <div class="item-name">${esc(title)}</div>
        <div class="item-type-label">${typeLabel}</div>
      </div>
      <button class="item-close-btn" ${removeAttr}="${esc(title)}">
        <span class="material-symbols-outlined" style="font-size:16px;">close</span>
      </button>
    `;
    if (placeholder) zone.insertBefore(card, placeholder);
    else zone.appendChild(card);

    dialog.hide();
    autoSaveTier();
  });

  // A2A-48: Create Item dialog — cancel handler
  document.getElementById('create-item-cancel')?.addEventListener('click', () => {
    document.getElementById('create-item-dialog')?.hide();
  });

  // Defaults form — unchanged from A2A-41
  document.getElementById('defaults-form')?.addEventListener('submit', async (e) => {
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

  // A2A-48: New Tier form — uses state.activeTierId instead of removed #tier-select
  document.getElementById('new-tier-form')?.addEventListener('submit', async (e) => {
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
    // A2A-48: Switch to the newly created tier (replaces old tier-select.value = tierId)
    state.activeTierId = tierId;
    renderPermissions();
  });

  // Preview dialog close — unchanged
  document.getElementById('preview-close-btn')?.addEventListener('click', () => {
    document.getElementById('preview-dialog').hide();
  });
}

// A2A-48: Load settings and render permissions. Replaces fillTierSelects() and
// renderTierColumns() calls with populateInviteTierSelect() + renderPermissions().
async function loadSettings() {
  const payload = await request('/settings');
  state.settings = payload;
  populateInviteTierSelect();
  renderPermissions();
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
  // A2A-48: Load fresh settings data when switching to Permissions tab.
  // Previously a no-op — now ensures data is current on tab switch.
  permissions: loadSettings,
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
  // A2A-48: bindPermissionsActions() replaces old bindSettingsActions() +
  // bindItemListDelegation(). All tier/tool/topic/goal handlers are now
  // inside bindPermissionsActions() using event delegation on #panel-permissions.
  bindPermissionsActions();
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
