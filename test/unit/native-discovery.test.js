module.exports = function (test, assert) {
  const fs = require('fs');
  const path = require('path');

  function readDiscoverySource() {
    return fs.readFileSync(
      path.join(__dirname, '..', '..', 'native', 'macos', 'src-tauri', 'src', 'discovery.rs'),
      'utf8'
    );
  }

  test('native discovery scans ports with port 80 first', () => {
    const source = readDiscoverySource();
    assert.includes(source, 'const DEFAULT_PORTS: &[u16] = &[80, 3001, 8080, 8443, 9001];');
  });

  test('native discovery reads onboarding and hostname-derived ports from config', () => {
    const source = readDiscoverySource();
    assert.includes(source, 'pub fn read_config_ports() -> Vec<u16>');
    assert.includes(source, 'config.onboarding.and_then(|ob| ob.server_port)');
    assert.includes(source, '.and_then(|agent| agent.hostname)');
    assert.includes(source, 'parse_port_from_hostname');
  });

  test('native discovery validates ping payload to avoid false positives', () => {
    const source = readDiscoverySource();
    assert.includes(source, 'body.contains("\\\"pong\\\":true")');
  });
};
