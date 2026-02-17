module.exports = function (test, assert) {
  const fs = require('fs');
  const path = require('path');

  test('postinstall does not auto-install native macOS app', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'postinstall.js'), 'utf8');
    assert.ok(!src.includes('installMacOSApp('), 'postinstall should not call installMacOSApp');
    assert.ok(!src.includes('function installMacOSApp'), 'postinstall should not define installMacOSApp');
    assert.includes(src, 'installSkillFiles()');
  });
};
