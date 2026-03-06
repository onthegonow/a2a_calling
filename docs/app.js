// A2A-102: Landing page platform detection and dynamic download URL
(function () {
  'use strict';

  var btn = document.getElementById('download-btn');
  if (!btn) return;

  // Only show "Download for macOS" on macOS
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || '') ||
    (navigator.userAgentData && navigator.userAgentData.platform === 'macOS');

  if (!isMac) {
    btn.textContent = 'View on GitHub';
    btn.href = 'https://github.com/onthegonow/a2a_calling';
    return;
  }

  // Try to get latest release URL from GitHub API
  fetch('https://api.github.com/repos/onthegonow/a2a_calling/releases/latest')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.assets) return;
      var dmg = data.assets.find(function (a) { return a.name.endsWith('.dmg'); });
      if (dmg && dmg.browser_download_url) {
        btn.href = dmg.browser_download_url;
        btn.textContent = 'Download ' + data.tag_name + ' for macOS';
      }
    })
    .catch(function () { /* keep default link */ });
})();
