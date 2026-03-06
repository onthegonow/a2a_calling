/* A2A-99: Onboarding wizard logic — vanilla JS + Shoelace */
(function () {
  'use strict';

  const PRESET_TOPICS = [
    { id: 'coding', label: 'Coding', icon: 'code' },
    { id: 'scheduling', label: 'Scheduling', icon: 'calendar_month' },
    { id: 'research', label: 'Research', icon: 'search' },
    { id: 'writing', label: 'Writing', icon: 'edit_note' },
    { id: 'email', label: 'Email', icon: 'mail' },
    { id: 'data-analysis', label: 'Data Analysis', icon: 'analytics' },
    { id: 'creative', label: 'Creative', icon: 'palette' },
    { id: 'math', label: 'Math', icon: 'calculate' },
    { id: 'general', label: 'General Chat', icon: 'chat' },
    { id: 'devops', label: 'DevOps', icon: 'terminal' },
    { id: 'documentation', label: 'Documentation', icon: 'description' },
    { id: 'debugging', label: 'Debugging', icon: 'bug_report' }
  ];

  const TIERS = [
    {
      id: 'public',
      name: 'Public',
      desc: 'Minimal access — callers can only read your agent\'s context. Best for unknown contacts.',
      capabilities: 'context-read'
    },
    {
      id: 'friends',
      name: 'Friends',
      desc: 'Moderate access — callers can read calendar, email, and search. Good for trusted colleagues.',
      capabilities: 'context-read, calendar.read, email.read, search'
    },
    {
      id: 'family',
      name: 'Family',
      desc: 'Full access — callers get tools, memory, and all capabilities. Only for highly trusted agents.',
      capabilities: 'context-read, calendar, email, search, tools, memory'
    }
  ];

  let currentStep = 1;
  const totalSteps = 4;
  let selectedTopics = new Set();
  let selectedTier = 'public';
  let detectedPort = null;

  // -- DOM refs --------------------------------------------------
  const btnNext = document.getElementById('btn-next');
  const btnBack = document.getElementById('btn-back');
  const errorEl = document.getElementById('wizard-error');

  // -- Initialize ------------------------------------------------
  function init() {
    // A2A-99: Check if already onboarded — redirect to dashboard if so.
    fetch('./onboarding/status')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.onboarded) {
          window.location.href = './';
          return;
        }
        // Pre-fill agent name from any partial onboarding state
        if (data.onboarding && data.onboarding.agentName) {
          const nameInput = document.getElementById('agent-name');
          if (nameInput) nameInput.value = data.onboarding.agentName;
        }
      })
      .catch(function () { /* proceed with wizard */ });

    renderTopicGrid();
    renderTierCards();
    updateNav();
    detectPort();

    btnNext.addEventListener('click', handleNext);
    btnBack.addEventListener('click', handleBack);
  }

  // -- Topic grid ------------------------------------------------
  function renderTopicGrid() {
    const grid = document.getElementById('topic-grid');
    grid.innerHTML = PRESET_TOPICS.map(function (t) {
      return '<div class="topic-chip" data-topic="' + t.id + '">' +
        '<span class="material-symbols-outlined">' + t.icon + '</span>' +
        t.label + '</div>';
    }).join('');

    grid.addEventListener('click', function (e) {
      const chip = e.target.closest('.topic-chip');
      if (!chip) return;
      const topic = chip.dataset.topic;
      if (selectedTopics.has(topic)) {
        selectedTopics.delete(topic);
        chip.classList.remove('selected');
      } else {
        selectedTopics.add(topic);
        chip.classList.add('selected');
      }
    });
  }

  // -- Tier cards ------------------------------------------------
  function renderTierCards() {
    const container = document.getElementById('tier-cards');
    container.innerHTML = TIERS.map(function (t) {
      return '<div class="tier-card' + (t.id === selectedTier ? ' selected' : '') + '" data-tier="' + t.id + '">' +
        '<h3>' + t.name + '</h3>' +
        '<p>' + t.desc + '</p>' +
        '</div>';
    }).join('');

    container.addEventListener('click', function (e) {
      const card = e.target.closest('.tier-card');
      if (!card) return;
      selectedTier = card.dataset.tier;
      container.querySelectorAll('.tier-card').forEach(function (c) { c.classList.remove('selected'); });
      card.classList.add('selected');
    });
  }

  // -- Port detection --------------------------------------------
  function detectPort() {
    const status = document.getElementById('port-status');
    const portInput = document.getElementById('server-port');
    status.textContent = 'Detecting available port...';
    status.className = 'port-status detecting';

    fetch('./onboarding/detect-port')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.port) {
          detectedPort = data.port;
          portInput.value = data.port;
          status.textContent = 'Port ' + data.port + ' is available.';
          status.className = 'port-status ok';
        } else {
          status.textContent = 'No available port found. Enter one manually.';
          status.className = 'port-status error';
        }
      })
      .catch(function () {
        status.textContent = 'Could not detect port. Enter one manually.';
        status.className = 'port-status error';
      });
  }

  // -- Navigation ------------------------------------------------
  function goToStep(step) {
    document.querySelectorAll('.wizard-step').forEach(function (el) { el.classList.remove('active'); });
    document.getElementById('step-' + step).classList.add('active');

    document.querySelectorAll('.progress-step').forEach(function (el) {
      const s = Number(el.dataset.step);
      el.classList.remove('active', 'done');
      if (s === step) el.classList.add('active');
      else if (s < step) el.classList.add('done');
    });

    currentStep = step;
    updateNav();
    hideError();
  }

  function updateNav() {
    btnBack.style.display = currentStep === 1 ? 'none' : '';

    if (currentStep === totalSteps) {
      btnNext.textContent = 'Finish Setup';
      // Remove suffix icon for finish button
      const suffix = btnNext.querySelector('[slot="suffix"]');
      if (suffix) suffix.textContent = 'check';
    } else {
      // Restore next icon
      const suffix = btnNext.querySelector('[slot="suffix"]');
      if (suffix) suffix.textContent = 'arrow_forward';
    }
  }

  function handleNext() {
    if (!validateStep(currentStep)) return;

    if (currentStep === totalSteps) {
      submitOnboarding();
    } else {
      goToStep(currentStep + 1);
    }
  }

  function handleBack() {
    if (currentStep > 1) {
      goToStep(currentStep - 1);
    }
  }

  // -- Validation ------------------------------------------------
  function validateStep(step) {
    if (step === 1) {
      const name = (document.getElementById('agent-name').value || '').trim();
      if (!name) {
        showError('Please enter a name for your agent.');
        return false;
      }
    }
    if (step === 4) {
      const port = Number.parseInt(document.getElementById('server-port').value, 10);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        showError('Please enter a valid port number (1-65535).');
        return false;
      }
    }
    return true;
  }

  // -- Submit ----------------------------------------------------
  function submitOnboarding() {
    const agentName = (document.getElementById('agent-name').value || '').trim();
    const port = Number.parseInt(document.getElementById('server-port').value, 10);
    const hostname = (document.getElementById('server-hostname').value || '').trim();

    // Merge preset selections with custom topics
    const customRaw = (document.getElementById('custom-topics').value || '').trim();
    const customTopics = customRaw
      ? customRaw.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
      : [];
    const allTopics = Array.from(selectedTopics).concat(customTopics);

    btnNext.loading = true;
    btnNext.disabled = true;
    hideError();

    fetch('./onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: agentName,
        defaultTier: selectedTier,
        port: port,
        hostname: hostname,
        topics: allTopics
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.success) {
          // A2A-99: Navigate to dashboard after successful onboarding.
          window.location.href = './';
        } else {
          const msg = (data.error && data.error.message) || 'Onboarding failed.';
          showError(msg);
        }
      })
      .catch(function (err) {
        showError('Network error: ' + (err.message || 'unknown'));
      })
      .finally(function () {
        btnNext.loading = false;
        btnNext.disabled = false;
      });
  }

  // -- Error helpers ---------------------------------------------
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  function hideError() {
    errorEl.style.display = 'none';
  }

  // -- Boot ------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
