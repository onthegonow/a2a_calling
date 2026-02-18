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
  }
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

function updaterPillClass(stateValue) {
  const state = String(stateValue || '').trim();
  if (state === 'failed') return 'err';
  if (state === 'waiting_for_safe_restart' || state === 'checking' || state === 'downloading' || state === 'applying' || state === 'restarting') {
    return 'warn';
  }
  return 'ok';
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

function bindTabs() {
  const activateTab = (tab, options = {}) => {
    const target = String(tab || '').replace(/^#/, '').trim();
    if (!target) return false;
    const btn = Array.from(document.querySelectorAll('.tab')).find(b => b.dataset.tab === target);
    const panel = document.getElementById(`tab-${target}`);
    if (!btn || !panel) return false;

    document.querySelectorAll('.tab').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    panel.classList.add('is-active');

    if (options.updateHash) {
      try { window.location.hash = target; } catch (err) {}
    }
    if (typeof onTabSwitch === 'function') onTabSwitch(target);
    return true;
  };

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab, { updateHash: true });
    });
  });

  window.addEventListener('hashchange', () => {
    activateTab(window.location.hash);
  });

  // Deep-link into a tab with /dashboard/#logs, etc.
  activateTab(window.location.hash);
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
      actionBits.push(`<button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-contact="${esc(c.id)}" type="button" title="${isPinned ? 'Unpin' : 'Pin to top'}">${isPinned ? '\u{1F4CC}' : '\u{1F4CD}'}</button>`);
    }
    if (c?.last_call_id) {
      actionBits.push(`<button data-open-call="${esc(c.last_call_id)}" type="button">Transcript</button>`);
    }
    actionBits.push(`<button data-toggle-mine="${esc(c.id)}" type="button">${mine ? 'Unmark mine' : 'Mark mine'}</button>`);
    actionBits.push(`<button data-remove-contact="${esc(c.id)}" type="button">Remove</button>`);

    const locationCell = opts.showLocation ? `<td>${esc(formatLocation(c))}</td>` : '';
    const ownerCell = opts.showOwner ? `<td>${esc(c?.owner || '-')}</td>` : '';
    const summaryCell = opts.showSummary ? `<td title="${esc(lastSummary)}">${esc(summaryPreview)}</td>` : '';

    return `
      <tr ${isSelected ? 'data-selected="1"' : ''}>
        <td>
          <div class="row" style="margin:0;">
            <button class="btn-link" data-contact-select="${esc(c.id)}" type="button">${esc(contactLabel(c))}</button>
            <button data-contact-call="${esc(c.id)}" type="button" ${canCall ? '' : 'disabled'}>Call</button>
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
    <div class="card">
      <h3>My agents</h3>
      ${tableHtml(myAgents, { showLocation: true, showOwner: false, showSummary: false })}
    </div>
  `;

  const lastCalledSection = `
    <div class="card">
      <h3>Last called agents</h3>
      ${tableHtml(lastCalled, { showLocation: false, showOwner: true, showSummary: false, showPin: true })}
    </div>
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
      <div class="card">
        <h3>${esc(owner)}</h3>
        ${tableHtml(rows, { showLocation: false, showOwner: false, showSummary: true })}
      </div>
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

  // Toggle button to show/hide Add Contact form
  const toggleBtn = document.getElementById('add-contact-toggle');
  const addCard = document.getElementById('add-contact-card');
  if (toggleBtn && addCard) {
    toggleBtn.addEventListener('click', () => {
      const isHidden = addCard.style.display === 'none';
      addCard.style.display = isHidden ? 'block' : 'none';
      toggleBtn.style.display = isHidden ? 'none' : 'block';
    });
  }

  const cancelBtn = document.getElementById('add-contact-cancel');
  if (cancelBtn && addCard && toggleBtn) {
    cancelBtn.addEventListener('click', () => {
      addCard.style.display = 'none';
      toggleBtn.style.display = 'block';
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
  urlEl?.addEventListener('blur', defaultServerNameFromUrl);
  urlEl?.addEventListener('change', defaultServerNameFromUrl);
  mineEl?.addEventListener('change', () => {
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
    const isMine = Boolean(document.getElementById('add-contact-mine')?.checked);
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
          is_mine: isMine,
          server_name: serverName || undefined,
          tags,
          notes: notes || undefined,
          fields
        })
      });
      showNotice('Contact added');
      form.reset();
      // Collapse the Add Contact form after successful add
      if (addCard) addCard.style.display = 'none';
      if (toggleBtn) toggleBtn.style.display = 'block';
      await loadContacts();
    } catch (err) {
      showNotice(err.message);
    }
  });

  const panel = document.getElementById('tab-contacts');
  panel?.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('button[data-pin-contact]');
    if (pinBtn) {
      e.preventDefault();
      const id = pinBtn.dataset.pinContact;
      if (id) togglePin(id);
      return;
    }

    const selectBtn = e.target.closest('button[data-contact-select]');
    if (selectBtn) {
      e.preventDefault();
      const id = selectBtn.dataset.contactSelect;
      if (id) {
        await loadCallsForContact(id);
      }
      return;
    }

    const openBtn = e.target.closest('button[data-open-call]');
    if (openBtn) {
      e.preventDefault();
      openCallTranscript(openBtn.dataset.openCall);
      return;
    }

    const mineBtn = e.target.closest('button[data-toggle-mine]');
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

    const removeBtn = e.target.closest('button[data-remove-contact]');
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

    const callBtn = e.target.closest('button[data-contact-call]');
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
    ? `<details class="transcript-details">
        <summary>Full Transcript (${countLabel})</summary>
        <pre class="transcript">${transcriptLines}</pre>
      </details>`
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
        ${result.conversation_id ? `Conversation: <span class="mono">${esc(result.conversation_id)}</span> <button data-open-call="${esc(result.conversation_id)}" type="button">Transcript</button><br>` : ''}
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
        <td><button data-open-call="${esc(call.id)}" type="button">Transcript</button></td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <div class="row">
      <h3 style="margin:0;">Contact: ${esc(contactLabel(contact))}</h3>
      <button data-contact-call="${esc(contact.id)}" type="button" ${canCall ? '' : 'disabled'}>Call</button>
      <button data-remove-contact="${esc(contact.id)}" type="button">Remove</button>
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

    <details style="margin-top:0.8rem;" open>
	      <summary><strong>Edit contact</strong></summary>
	      <form id="contact-edit-form" data-contact-id="${esc(contact.id)}" style="margin-top:0.6rem;">
	        <label>Agent name <input id="contact-edit-name" type="text" value="${esc(contact.name || '')}"></label>
	        <label>Owner name <input id="contact-edit-owner" type="text" value="${esc(contact.owner || '')}"></label>
	        <label><input id="contact-edit-mine" type="checkbox" ${contact.is_mine ? 'checked' : ''}> Mark as mine (personal agent)</label>
	        <label>Server name (my agents only) <input id="contact-edit-server-name" type="text" value="${esc(contact.server_name || '')}" ${contact.is_mine ? '' : 'disabled'}></label>
	        <label>Tags <input id="contact-edit-tags" type="text" value="${esc(tagsText)}" placeholder="comma,separated"></label>
	        <label>Notes <textarea id="contact-edit-notes" rows="3">${esc(contact.notes || '')}</textarea></label>
	        <label>Fields (JSON) <textarea id="contact-edit-fields" rows="5">${esc(fieldsText)}</textarea></label>
	        <div class="row">
	          <button type="submit">Save</button>
	        </div>
	      </form>
	    </details>

    <details style="margin-top:0.8rem;" open>
      <summary><strong>Call</strong></summary>
      <form id="contact-call-form" data-contact-id="${esc(contact.id)}" style="margin-top:0.6rem;">
        <label>Message <textarea id="contact-call-message" rows="4" placeholder="Message to send"></textarea></label>
        <div class="row">
          <button type="submit" ${canCall ? '' : 'disabled'}>Call</button>
        </div>
      </form>
    </details>

    <details style="margin-top:0.8rem;">
      <summary><strong>Call history</strong></summary>
      <div style="margin-top:0.6rem;">
        <table>
          <thead><tr><th>ID</th><th>Status</th><th>Updated</th><th>Summary</th><th>Action</th></tr></thead>
          <tbody>${callRows || '<tr><td colspan="5">No calls found.</td></tr>'}</tbody>
        </table>
      </div>
    </details>
  `;

  const editForm = document.getElementById('contact-edit-form');
  if (editForm) {
    const mineEl = document.getElementById('contact-edit-mine');
    const serverNameEl = document.getElementById('contact-edit-server-name');
    mineEl?.addEventListener('change', () => {
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
      <strong>By level:</strong> ${levels.map(([k, v]) => `${esc(k)}=${v}`).join(' · ') || '(none)'}
    </div>
    <div class="row">
      <strong>Top components:</strong> ${components.map(([k, v]) => `${esc(k)}=${v}`).join(' · ') || '(none)'}
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
      <button id="clear-trace">Clear</button>
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
      <td class="mono">${esc(trace ? trace.slice(0, 14) + '…' : '-')}</td>
      <td class="mono">${esc(row.conversation_id ? row.conversation_id.slice(0, 14) + '…' : '-')}</td>
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

function fillTierSelects() {
  const tiers = (state.settings?.tiers || []).slice().sort((a, b) => a.id.localeCompare(b.id));
  const tierSelect = document.getElementById('tier-select');
  const copyFrom = document.getElementById('copy-from-tier');
  const newTierCopy = document.getElementById('new-tier-copy-from');
  const inviteTier = document.getElementById('invite-tier');

  [tierSelect, copyFrom, inviteTier].forEach(el => { el.innerHTML = ''; });
  newTierCopy.innerHTML = '<option value="">None</option>';

  tiers.forEach(tier => {
    const option = new Option(`${tier.id} (${tier.name || tier.id})`, tier.id);
    tierSelect.add(option.cloneNode(true));
    copyFrom.add(option.cloneNode(true));
    inviteTier.add(option.cloneNode(true));
    newTierCopy.add(option.cloneNode(true));
  });

  if (tiers.length > 0) {
    tierSelect.value = tiers[0].id;
    copyFrom.value = tiers[0].id;
    inviteTier.value = tiers[0].id;
    renderTierEditor(tiers[0].id);
  }
}

function renderTierEditor(tierId) {
  const tier = (state.settings?.tiers || []).find(t => t.id === tierId);
  if (!tier) return;

  document.getElementById('tier-id').value = tier.id;
  document.getElementById('tier-name').value = tier.name || tier.id;
  document.getElementById('tier-description').value = tier.description || '';
  document.getElementById('tier-disclosure').value = tier.disclosure || 'minimal';
  document.getElementById('tier-tools').value = toLines(tier.allowed_tools || []);
  document.getElementById('tier-topics').value = toLines(tier.topics || []);
  document.getElementById('tier-goals').value = toLines(tier.goals || []);
}

function bindSettingsActions() {
  document.getElementById('tier-select').addEventListener('change', (e) => {
    renderTierEditor(e.target.value);
  });

  document.getElementById('tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tierId = document.getElementById('tier-id').value;
    const body = {
      name: document.getElementById('tier-name').value,
      description: document.getElementById('tier-description').value,
      disclosure: document.getElementById('tier-disclosure').value,
      allowed_tools: fromLines(document.getElementById('tier-tools').value),
      topics: fromLines(document.getElementById('tier-topics').value),
      goals: fromLines(document.getElementById('tier-goals').value)
    };
    await request(`/settings/tiers/${encodeURIComponent(tierId)}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    showNotice(`Saved tier "${tierId}"`);
    await loadSettings();
  });

  document.getElementById('copy-tier-btn').addEventListener('click', async () => {
    const toTier = document.getElementById('tier-id').value;
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
}

async function loadSettings() {
  const payload = await request('/settings');
  state.settings = payload;
  fillTierSelects();
  document.getElementById('defaults-expiration').value = payload.defaults?.expiration || '7d';
  document.getElementById('defaults-max-calls').value = payload.defaults?.maxCalls || 100;
}

function renderCallbookStatus() {
  const el = document.getElementById('callbook-status');
  if (!el) return;

  const s = state.dashboardStatus;
  if (!s) {
    el.textContent = 'Loading…';
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
    ? `<details style="margin-top:0.5rem;">
        <summary>External IP probe</summary>
        <div class="mono" style="margin-top:0.35rem;">
          ${extAttempts.map(a => {
            const service = a && a.service ? String(a.service) : '-';
            const ok = Boolean(a && a.ok);
            const status = a && a.statusCode ? ` (${a.statusCode})` : '';
            const err = a && a.error ? ` (${a.error})` : '';
            return esc(`${service}: ${ok ? 'ok' + status : 'failed' + err}`);
          }).join('<br>')}
        </div>
      </details>`
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
    el.textContent = 'Loading…';
    if (toggleBtn) toggleBtn.disabled = true;
    return;
  }

  const stateText = formatUpdaterState(au.state);
  const pillClass = updaterPillClass(au.state);
  const enabled = Boolean(au.enabled);
  const intervalSec = Number.isFinite(au.interval_ms) ? Math.floor(au.interval_ms / 1000) : null;

  el.innerHTML = `
    <div><strong>Status:</strong> <span class="status-pill ${pillClass}">${esc(stateText)}</span></div>
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
        <button data-revoke="${esc(dev.id)}" ${revoked ? 'disabled' : ''}>Revoke</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-revoke]').forEach(btn => {
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
      <td>${invite.revoked ? 'revoked' : 'active'}</td>
      <td><button data-revoke="${invite.id}" ${invite.revoked ? 'disabled' : ''}>Revoke</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-revoke]').forEach(btn => {
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
  const toggleBtn = document.getElementById('generate-invite-toggle');
  const inviteCard = document.getElementById('generate-invite-card');
  const cancelBtn = document.getElementById('generate-invite-cancel');
  const inviteMessageWrap = document.getElementById('invite-message-wrap');
  const inviteMessage = document.getElementById('invite-message');

  // Toggle button to show/hide Generate Invite form
  if (toggleBtn && inviteCard) {
    toggleBtn.addEventListener('click', () => {
      const isHidden = inviteCard.style.display === 'none';
      inviteCard.style.display = isHidden ? 'block' : 'none';
      toggleBtn.style.display = isHidden ? 'none' : 'block';
    });
  }

  // Cancel button collapses the form
  if (cancelBtn && inviteCard && toggleBtn) {
    cancelBtn.addEventListener('click', () => {
      inviteCard.style.display = 'none';
      toggleBtn.style.display = 'block';
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
    // Collapse the form after successful creation
    if (inviteCard) inviteCard.style.display = 'none';
    if (toggleBtn) toggleBtn.style.display = 'block';
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
    el.addEventListener('input', schedule);
    el.addEventListener('change', schedule);
  });
}

// --- Smart tab polling ---

let pollTimer = null;

function getActiveTab() {
  return document.querySelector('.tab.is-active')?.dataset?.tab || 'contacts';
}

const tabLoaders = {
  contacts: loadContacts,
  calls: loadCalls,
  logs: () => { loadLogs(); loadLogStats(); },
  settings: () => {},
  invites: loadInvites,
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

async function bootstrap() {
  bindTabs();
  bindContactsActions();
  bindSettingsActions();
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
