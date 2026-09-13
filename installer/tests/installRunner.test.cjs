const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createInstallRunner } = require('../app/installRunner.cjs');
const { getDefaults } = require('../app/installOptions.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

test('finishes after engine exit while an auto-started process keeps both output pipes open', { timeout: 6000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'velron-exit-test-'));
  const pidFile = path.join(directory, 'server.pid');
  t.after(async () => {
    try { process.kill(Number(await fs.readFile(pidFile, 'utf8'))); } catch { /* Already exited. */ }
    // Windows can retain the child's working-directory handle briefly after termination.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const fixture = path.join(directory, 'engine.cjs');
  await fs.writeFile(fixture, `
    const { spawn } = require('node:child_process');
    const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    });
    require('node:fs').writeFileSync(process.argv[2], String(server.pid));
    server.unref();
    console.log('VELRON_INSTALL_STAGE:complete');
  `);
  const events = [];
  let engine;
  let exited = false;
  const runner = createInstallRunner({ engineDir: directory, onEvent: event => events.push(event),
    spawnProcess: (_command, _args, options) => {
      engine = spawn(process.execPath, [fixture, pidFile], options);
      engine.once('exit', () => { exited = true; });
      return engine;
    } });
  t.after(() => { engine?.stdout.destroy(); engine?.stderr.destroy(); });
  const result = await runner.run(getDefaults(process.platform));
  assert.equal(exited, true);
  assert.equal(result.status, 'success');
  assert.equal(runner.running, false);
  assert.equal(events.filter(event => event.type === 'result').length, 1);
  assert.ok(events.some(event => event.stage === 'complete'));
  // Reporting completion must not terminate the launched server.
  process.kill(Number(await fs.readFile(pidFile, 'utf8')), 0);
});

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

test('Windows resolves powershell through PATH with hidden window and settings outside the command line', async () => {
  let launched;
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const runner = createInstallRunner({ engineDir: 'C:\\App\\engine', platform: 'win32', environment: { PATH: 'C:\\PowerShell' },
    onEvent: () => {}, spawnProcess: (...args) => { launched = args; return child; } });
  const promise = runner.run(getDefaults('win32', 'C:\\Users\\Focus', {}));
  child.stdout.end(); child.stderr.end(); child.emit('close', 0);
  assert.equal((await promise).status, 'success');
  assert.equal(launched[0], 'powershell');
  assert.equal(launched[2].env.PATH, 'C:\\PowerShell');
  assert.equal(launched[2].shell, false);
  assert.ok(launched[1].includes('-File'));
  assert.equal(launched[2].windowsHide, true);
  assert.ok(!launched[1].join(' ').includes('Users'));
});

test('exit fallback preserves failure and final redacted diagnostics; late events cannot affect a retry', { timeout: 5000 }, async () => {
  const events = [];
  const children = [];
  const secret = 'b'.repeat(43);
  const runner = createInstallRunner({ engineDir: 'C:\\engine', platform: 'win32', onEvent: event => events.push(event),
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(child);
      return child;
    } });
  const options = { ...getDefaults('win32', 'C:\\Users\\Focus', {}), vcpToken: secret };
  const first = runner.run(options);
  children[0].stdout.write('VELRON_INSTALL_STAGE:complete\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(event => event.type === 'result').length, 0);
  children[0].emit('exit', 7);
  // Cancellation after exit must not taskkill the already-finished engine tree.
  runner.cancel();
  assert.equal(children.length, 1);
  children[0].stderr.write('! Final diagnostic ' + secret);
  const result = await first;
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.deepEqual(result.warnings, ['! Final diagnostic [redacted]']);
  assert.ok(!JSON.stringify(events).includes(secret));

  const second = runner.run(options);
  children[0].stdout.write('stale output\n');
  children[0].emit('close', 0);
  children[0].emit('error', new Error('stale error'));
  assert.equal(runner.running, true);
  assert.equal(runner.logs, '');
  children[1].stdout.end('final retry log\n');
  children[1].stderr.end();
  await new Promise(resolve => setImmediate(resolve));
  children[1].emit('exit', 0);
  children[1].emit('close', 0);
  assert.equal((await second).status, 'success');
  assert.equal(events.filter(event => event.type === 'result').length, 2);
  for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
});

test('spawn failure reports one failed result and releases the runner', async () => {
  const events = [];
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const runner = createInstallRunner({ engineDir: '/engine', onEvent: event => events.push(event), spawnProcess: () => child });
  const promise = runner.run(getDefaults());
  child.emit('error', new Error('spawn powershell ENOENT'));
  child.emit('close', -2);
  assert.equal((await promise).status, 'failed');
  assert.equal(runner.running, false);
  assert.equal(events.filter(event => event.type === 'result').length, 1);
  assert.match(runner.logs, /ENOENT/);
  child.stdout.destroy(); child.stderr.destroy();
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
