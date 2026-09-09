const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getDefaults, validateOptions, toEnvironment } = require('../app/installOptions.cjs');

test('Unix and Windows choices use native absolute paths and encode every installer setting', () => {
  for (const [platform, home] of [['linux', '/home/focus'], ['darwin', '/Users/focus'], ['win32', 'C:\\Users\\Focus']]) {
    const options = validateOptions(getDefaults(platform, home, {}), platform, { home });
    assert.equal(options.components, 'both');
    assert.equal(Object.keys(toEnvironment(options)).length, 14);
    assert.equal(toEnvironment(options).VELRON_INSTALL_KEEP_CONFIG, 'true');
  }
});

test('remote mode validates credentials, path, scheme, token and clears unused secrets', () => {
  const options = { ...getDefaults('linux', '/home/focus'), connection: 'remote', vcpUrl: 'wss://example.com:4141/vcp/v1', vcpToken: 'a'.repeat(43) };
  assert.equal(validateOptions(options, 'linux').vcpToken.length, 43);
  for (const url of ['http://example.com/vcp/v1', 'wss://a:b@example.com/vcp/v1', 'wss://example.com/vcp/v2', 'wss://example.com/vcp/v1?', 'wss://example.com/vcp/v1#']) {
    assert.throws(() => validateOptions({ ...options, vcpUrl: url }, 'linux'));
  }
  assert.throws(() => validateOptions({ ...options, vcpToken: 'short' }, 'linux'));
  assert.equal(validateOptions({ ...options, connection: 'local' }, 'linux').vcpToken, '');
  assert.equal(validateOptions({ ...options, components: 'server' }, 'linux').vcpToken, '');
  assert.equal(validateOptions({ ...options, components: 'server' }, 'linux').connection, 'local');
  assert.equal(validateOptions({ ...options, components: 'client', httpPort: 0 }, 'linux').httpPort, 4141);
});

test('rejects malformed inputs at the privileged boundary', () => {
  const base = getDefaults('linux', '/home/focus');
  for (const patch of [{ commandDir: 'relative' }, { velronHome: '/a\n/b' }, { httpPort: 0 }, { vcpPort: 4141 }, { keepConfig: 'true' }, { components: 'nothing' }, { integration: 'shell' }, { serverHost: 'x;curl evil' }, { allowedHosts: 'x,$(id)' }, { arbitraryCommand: 'whoami' }]) {
    assert.throws(() => validateOptions({ ...base, ...patch }, 'linux'));
  }
  const windows = getDefaults('win32', 'C:\\Users\\Focus', {});
  for (const commandDir of ['C:relative', '\\rooted-without-drive', 'C:\\%TEMP%\\bin', 'C:\\bad|path']) assert.throws(() => validateOptions({ ...windows, commandDir }, 'win32', { home: 'C:\\Users\\Focus' }));
});

test('rejects paths the Server and Client cannot use as a dedicated state home', () => {
  const home = '/home/focus';
  const cwd = '/work/installer';
  const base = getDefaults('linux', home);
  for (const velronHome of ['/', '/home/focus', '/home/focus ', '/home/focus/sub/..', cwd, base.commandDir]) {
    assert.throws(() => validateOptions({ ...base, velronHome }, 'linux', { home, cwd }));
  }
  assert.equal(validateOptions({ ...base, velronHome: ' /home/focus/.velron ' }, 'linux', { home, cwd }).velronHome, '/home/focus/.velron');
  const windowsHome = 'C:\\Users\\Focus';
  const windows = getDefaults('win32', windowsHome, {});
  for (const velronHome of ['C:\\', windowsHome, 'c:\\users\\FOCUS', 'D:\\Velron',
    '\\\\server\\share\\Velron', 'C:\\Users\\Focus-Other\\Velron', windows.commandDir]) {
    assert.throws(() => validateOptions({ ...windows, components: 'client', velronHome }, 'win32', { home: windowsHome }));
  }
  assert.equal(validateOptions(windows, 'win32', { home: windowsHome }).velronHome, 'C:\\Users\\Focus\\.velron');
});

test('bind hosts and allowed hosts obey different runtime IPv6 rules and DNS bounds', () => {
  const base = getDefaults('linux', '/home/focus');
  for (const serverHost of ['[::1]', 'localhost:4141', 'invalid_host', 'host.', '-host', 'host-',
    'a'.repeat(64) + '.com', 'http://localhost', 'host/path']) {
    assert.throws(() => validateOptions({ ...base, serverHost }, 'linux'));
  }
  for (const serverHost of ['localhost', '  localhost  ', '127.0.0.1', '0.0.0.0', '::', '::1', 'my-host.example']) {
    assert.equal(validateOptions({ ...base, serverHost }, 'linux').serverHost, serverHost.trim());
  }
  assert.equal(validateOptions({ ...base, allowedHosts: ' [::1],LOCALHOST,localhost, ::1 ' }, 'linux').allowedHosts,
    '[::1],localhost,::1');
  for (const allowedHosts of ['[127.0.0.1]', 'localhost:4141', 'invalid_host', new Array(257).fill('host').join(',')]) {
    assert.throws(() => validateOptions({ ...base, allowedHosts }, 'linux'));
  }
});
