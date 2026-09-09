const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isServerSettings } = require('../app/serverSettings.cjs');

const settings = { schemaVersion: 1, host: '127.0.0.1', port: 4141, localVcpPort: 4143,
  allowedHosts: [], managementSecureCookies: false, maxConcurrentRuns: 4,
  maxRunStartsPerMinute: 60, maxRunContextBytes: 8 * 1024 * 1024 };

test('keep-config validation checks the complete strict runtime schema', () => {
  assert.equal(isServerSettings(settings), true);
  for (const patch of [{ schemaVersion: 2 }, { host: '[::1]' }, { localVcpPort: 4141 },
    { allowedHosts: ['host:4141'] }, { managementSecureCookies: 'false' }, { maxConcurrentRuns: 0 },
    { maxRunStartsPerMinute: 100001 }, { maxRunContextBytes: 128 * 1024 * 1024 + 1 },
    { undocumented: true }]) {
    assert.equal(isServerSettings({ ...settings, ...patch }), false, JSON.stringify(patch));
  }
  for (const key of Object.keys(settings)) {
    const incomplete = { ...settings };
    delete incomplete[key];
    assert.equal(isServerSettings(incomplete), false, key);
  }
  assert.equal(isServerSettings({ ...settings, host: ' ::1 ', allowedHosts: ['[::1]', 'LOCALHOST'] }), true);
});
