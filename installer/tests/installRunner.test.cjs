const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createInstallRunner } = require('../app/installRunner.cjs');
const { getDefaults } = require('../app/installOptions.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('streams progress, redacts a token split across chunks, and never uses a shell command string', async () => {
  const events = [];
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const secret = 'a'.repeat(43);
  let launched;
  const runner = createInstallRunner({ engineDir: '/bundle with spaces', onEvent: event => events.push(event), platform: 'linux',
    environment: { PATH: '/bin', VELRON_INSTALL_UNRECOGNIZED: 'bad' },
    spawnProcess: (...args) => { launched = args; return child; } });
  const promise = runner.run({ ...getDefaults('linux', '/home/focus'), vcpToken: secret });
  assert.equal(runner.running, true);
  assert.throws(() => runner.run({}));
  child.stdout.write('VELRON_INSTALL_STAGE:download\n');
  child.stderr.write('! Cannot connect with token ' + secret.slice(0, 10));
  child.stderr.write(secret.slice(10) + '\n');
  child.stdout.end(); child.stderr.end();
  await new Promise(resolve => setImmediate(resolve));
  child.emit('close', 1);
  const result = await promise;
  assert.equal(result.status, 'failed');
  assert.equal(result.warnings.length, 1);
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.ok(runner.logs.includes('[redacted]'));
  assert.deepEqual(launched[1], ['/bundle with spaces/install.sh', '--non-interactive']);
  assert.equal(launched[2].shell, false);
  assert.equal(launched[2].env.VELRON_INSTALL_UNRECOGNIZED, undefined);
  assert.equal(runner.running, false);
});

test('Windows uses system PowerShell with hidden window and settings outside the command line', async () => {
  let launched;
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const runner = createInstallRunner({ engineDir: 'C:\\App\\engine', platform: 'win32', environment: { SystemRoot: 'C:\\Windows' },
    onEvent: () => {}, spawnProcess: (...args) => { launched = args; return child; } });
  const promise = runner.run(getDefaults('win32', 'C:\\Users\\Focus', {}));
  child.stdout.end(); child.stderr.end(); child.emit('close', 0);
  assert.equal((await promise).status, 'success');
  assert.equal(launched[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(launched[1].includes('-File'));
  assert.equal(launched[2].windowsHide, true);
  assert.ok(!launched[1].join(' ').includes('Users'));
});

test('cancellation terminates the running installer tree and reports a cancelled result', { skip: process.platform === 'win32', timeout: 7000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'velron-cancel-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'install.sh'), 'trap "exit 143" TERM\necho ready\nwhile :; do sleep 1; done\n');
  let runner;
  runner = createInstallRunner({ engineDir: directory, onEvent: event => {
    if (event.type === 'log' && event.line === 'ready') runner.cancel();
  } });
  const result = await runner.run(getDefaults(process.platform));
  assert.equal(result.status, 'cancelled');
  assert.equal(runner.running, false);
});
