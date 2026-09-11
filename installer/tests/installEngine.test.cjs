const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getDefaults, toEnvironment } = require('../app/installOptions.cjs');
const exec = promisify(execFile);
const engine = path.resolve(__dirname, '../../install.sh');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velron-engine-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home with 'quotes and \\slashes");
  const bin = path.join(dir, 'tools'); const downloads = path.join(dir, 'downloads');
  await Promise.all([home, bin, downloads].map(value => fs.mkdir(value, { recursive: true })));
  const assets = [];
  for (const component of ['velron', 'velron-client']) {
    for (const platform of ['linux', 'macos']) for (const arch of ['x64', 'arm64']) {
      const name = `${component}-${platform}-${arch}`;
      const content = '#!/bin/sh\nprintf "fake binary\\n"\n';
      await fs.writeFile(path.join(downloads, name), content);
      assets.push(crypto.createHash('sha256').update(content).digest('hex') + '  ' + name);
    }
  }
  await fs.writeFile(path.join(downloads, 'SHA256SUMS.txt'), assets.join('\n') + '\n');
  await fs.writeFile(path.join(bin, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in https://*) url=$1;; -o) shift; output=$1;; esac\n shift\ndone\ncp "$FAKE_DOWNLOADS/${url##*/}" "$output"\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const host of ['codex', 'claude']) await fs.writeFile(path.join(bin, host), '#!/bin/sh\n[ "$1 $2 $3" = "mcp get --help" ] && exit 0\n[ "$1 $2 $3" = "mcp get velron" ] && exit "${FAKE_EXISTING_ENTRY:-1}"\nprintf "%s\\n" "$*" >> "$FAKE_HOST_CALLS"\nexit 0\n', { mode: 0o755 });
  const options = { ...getDefaults(process.platform, home), autostart: false, startNow: false, integration: 'both' };
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_CONFIG_HOME: path.join(dir, 'config'), FAKE_DOWNLOADS: downloads, FAKE_HOST_CALLS: path.join(dir, 'host-calls'), NO_COLOR: '1',
    DISPLAY: '', WAYLAND_DISPLAY: '' };
  return { dir, home, bin, downloads, options, env, run: (patch = {}, extra = {}) => exec('/bin/sh', [engine, '--non-interactive'], {
    env: { ...env, ...toEnvironment({ ...options, ...patch }), ...extra }, timeout: 20000, maxBuffer: 1024 * 1024,
  }) };
}

test('headless engine installs both components, configures remote MCP and preserves exact quoted paths', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const token = 'a'.repeat(43);
  const { stdout } = await f.run({ connection: 'remote', vcpUrl: 'wss://example.com:4141/vcp/v1', vcpToken: token });
  assert.match(stdout, /VELRON_INSTALL_STAGE:complete/);
  assert.ok(!stdout.includes(token));
  const config = JSON.parse(await fs.readFile(path.join(f.options.velronHome, 'config.json'), 'utf8'));
  assert.equal(config.port, 4141);
  const mcp = JSON.parse(await fs.readFile(path.join(f.options.velronHome, 'stdio-mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.velron.command, path.join(f.options.commandDir, 'velron-client'));
  const privateEnv = path.join(f.options.velronHome, 'client.env');
  assert.equal((await fs.stat(privateEnv)).mode & 0o777, 0o600);
  const { stdout: configured } = await exec('/bin/sh', ['-c', '. "$1"; printf "%s" "$VELRON_HOME"', 'test', privateEnv]);
  assert.equal(configured, f.options.velronHome);
  assert.equal((await fs.readFile(f.env.FAKE_HOST_CALLS, 'utf8')).split('\n').filter(Boolean).length, 2);
});

test('component-only installs, existing config, MCP entries and local reconnection are preserved correctly', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await f.run({ components: 'server', keepConfig: false, httpPort: 5151, vcpPort: 5153 });
  await assert.rejects(fs.stat(path.join(f.options.velronHome, 'stdio-mcp.json')));
  const before = await fs.readFile(path.join(f.options.velronHome, 'config.json'), 'utf8');
  const { stdout } = await f.run({}, { FAKE_EXISTING_ENTRY: '0' });
  assert.equal(await fs.readFile(path.join(f.options.velronHome, 'config.json'), 'utf8'), before);
  assert.match(stdout, /Preserved the existing codex/);
  await assert.rejects(fs.stat(f.env.FAKE_HOST_CALLS));
  await f.run({ components: 'client', connection: 'remote', vcpUrl: 'wss://example.com/vcp/v1', vcpToken: 'b'.repeat(43) });
  await f.run({ components: 'client', connection: 'local' });
  const clientEnv = await fs.readFile(path.join(f.options.velronHome, 'client.env'), 'utf8');
  assert.ok(!clientEnv.includes('VELRON_VCP_TOKEN'));
  assert.equal(await fs.readFile(path.join(f.options.velronHome, 'config.json'), 'utf8'), before);
  assert.equal((await fs.readFile(path.join(f.home, '.profile'), 'utf8')).match(/# >>> velron >>>/g).length, 1);
});

test('checksum failures and invalid selections fail before installing unverified binaries', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.downloads, 'SHA256SUMS.txt'), '0'.repeat(64) + '  velron-' + (process.platform === 'darwin' ? 'macos' : 'linux') + '-' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '\n');
  await assert.rejects(f.run(), error => error.code !== 0 && /SHA-256 verification failed/.test(error.stderr));
  await assert.rejects(fs.stat(path.join(f.options.commandDir, 'velron')));
  await assert.rejects(f.run({ components: 'typo' }), error => error.code !== 0);
});

async function rewriteAssets(f, version, corruptClient = false) {
  const sums = [];
  for (const name of await fs.readdir(f.downloads)) {
    if (name === 'SHA256SUMS.txt') continue;
    const content = `#!/bin/sh\nprintf '${version} %s %s %s\\n' "\${VELRON_VCP_URL-unset}" "\${VELRON_VCP_TOKEN-unset}" "\${VELRON_LOCAL_VCP_PORT-unset}"\n`;
    await fs.writeFile(path.join(f.downloads, name), content);
    sums.push((corruptClient && name.startsWith('velron-client-') ? '0'.repeat(64) : crypto.createHash('sha256').update(content).digest('hex')) + '  ' + name);
  }
  await fs.writeFile(path.join(f.downloads, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
}

test('a later Client checksum failure leaves both existing runtimes and configuration intact', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await rewriteAssets(f, 'old'); await f.run();
  const paths = ['velron-runtime', 'velron-client-runtime'].map(name => path.join(f.env.XDG_DATA_HOME, 'velron/bin', name));
  paths.push(path.join(f.options.velronHome, 'config.json'));
  const before = await Promise.all(paths.map(file => fs.readFile(file, 'utf8')));
  await rewriteAssets(f, 'new', true);
  await assert.rejects(f.run(), error => /SHA-256 verification failed for velron-client/.test(error.stderr));
  assert.deepEqual(await Promise.all(paths.map(file => fs.readFile(file, 'utf8'))), before);
});

test('a second binary swap failure restores the first runtime and removes staging files', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await rewriteAssets(f, 'old'); await f.run();
  const runtimeDir = path.join(f.env.XDG_DATA_HOME, 'velron/bin');
  const oldPair = await Promise.all(['velron-runtime', 'velron-client-runtime'].map(name => fs.readFile(path.join(runtimeDir, name), 'utf8')));
  await rewriteAssets(f, 'new');
  await fs.writeFile(path.join(f.bin, 'mv'), '#!/bin/sh\nfor arg in "$@"; do\n case "$arg" in */velron-client-runtime.new.*) exit 73;; esac\ndone\nexec /bin/mv "$@"\n', { mode: 0o755 });
  await assert.rejects(f.run(), error => error.code === 73);
  assert.deepEqual(await Promise.all(['velron-runtime', 'velron-client-runtime'].map(name => fs.readFile(path.join(runtimeDir, name), 'utf8'))), oldPair);
  assert.deepEqual((await fs.readdir(runtimeDir)).sort(), ['velron-client-runtime', 'velron-runtime']);
});

test('changing command directory updates the managed PATH block and preserves user profile content', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const profile = path.join(f.home, '.profile');
  await fs.writeFile(profile, '# User profile\nexport USER_CHOICE=kept\n');
  await f.run();
  const commandDir = path.join(f.home, 'replacement-bin'); await f.run({ commandDir });
  const body = await fs.readFile(profile, 'utf8');
  assert.match(body, /export USER_CHOICE=kept/);
  assert.equal((body.match(/# >>> velron >>>/g) || []).length, 1);
  const { stdout } = await exec('/bin/sh', ['-c', '. "$1"; command -v velron', 'test', profile], { env: { ...f.env, PATH: '/usr/bin:/bin' } });
  assert.equal(stdout.trim(), path.join(commandDir, 'velron'));
});

test('local Client selection clears stale inherited remote credentials and discovery override', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await rewriteAssets(f, 'local');
  await f.run({ components: 'client', connection: 'local' });
  const { stdout } = await exec(path.join(f.options.commandDir, 'velron-client'), [], {
    env: { ...f.env, VELRON_VCP_URL: 'wss://stale.example/vcp/v1', VELRON_VCP_TOKEN: 'synthetic-secret', VELRON_LOCAL_VCP_PORT: '9999' },
  });
  assert.equal(stdout.trim(), 'local unset unset unset');
});

test('an immediately exiting Server never reports startup or installation success', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ components: 'server', startNow: true }), error => {
    assert.match(error.stderr, /Server exited before becoming ready/);
    assert.doesNotMatch(error.stdout, /VELRON_INSTALL_STAGE:complete|authentication is ready/);
    return true;
  });
});

test('startup waits for a live authentication endpoint using the preserved management port', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const listener = require('node:net').createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  await f.run({ components: 'server', keepConfig: false, httpPort: port });
  // Exercise compact JSON as well as the normal multiline config emitted by the engine.
  const configFile = path.join(f.options.velronHome, 'config.json');
  await fs.writeFile(configFile, JSON.stringify(JSON.parse(await fs.readFile(configFile, 'utf8'))));
  const pidFile = path.join(f.dir, 'server.pid');
  const program = `#!${process.execPath}\nconst fs=require('node:fs');const config=JSON.parse(fs.readFileSync(process.env.VELRON_HOME+'/config.json'));fs.writeFileSync(process.env.FAKE_SERVER_PID,String(process.pid));require('node:http').createServer((request,response)=>{response.writeHead(401,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{code:'management_authentication_required'}}));}).listen(config.port,config.host);\n`;
  const sums = [];
  for (const name of await fs.readdir(f.downloads)) {
    if (name === 'SHA256SUMS.txt') continue;
    await fs.writeFile(path.join(f.downloads, name), program);
    sums.push(crypto.createHash('sha256').update(program).digest('hex') + '  ' + name);
  }
  await fs.writeFile(path.join(f.downloads, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  const realCurl = (await exec('/bin/sh', ['-c', 'command -v curl'])).stdout.trim();
  const fakeCurl = path.join(f.bin, 'curl');
  const downloadAdapter = await fs.readFile(fakeCurl, 'utf8');
  await fs.writeFile(fakeCurl, downloadAdapter.replace('#!/bin/sh\n', '#!/bin/sh\nfor arg in "$@"; do\n case "$arg" in http://*) exec "$FAKE_REAL_CURL" "$@";; esac\ndone\n'));
  try {
    const { stdout } = await f.run({ components: 'server', startNow: true }, { FAKE_SERVER_PID: pidFile, FAKE_REAL_CURL: realCurl });
    assert.match(stdout, /authentication is ready/);
    assert.match(stdout, /VELRON_INSTALL_STAGE:complete/);
  } finally {
    const pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => '0'));
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
});

test('unsafe state locations and malformed hosts fail before creating installed files', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  for (const velronHome of [f.home, '/', path.join(f.home, '..', path.basename(f.home))]) {
    await assert.rejects(f.run({ velronHome }), error => /dedicated directory/.test(error.stderr));
  }
  for (const serverHost of ['[::1]', 'localhost:4141', 'invalid_host', '2001:::1']) {
    await assert.rejects(f.run({ serverHost }), error => /Invalid server bind host/.test(error.stderr));
  }
  for (const serverHost of ['::1', '2001:db8::1', '::ffff:192.168.1.1', 'example.test']) {
    await f.run({ components: 'server', serverHost, keepConfig: false });
  }
});

async function desktopArchive(f, { content = '#!/bin/sh\nexit 0\n', unsafeLink = false } = {}) {
  const platform = process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const name = `Velron-Status-${platform}-${arch}.tar.gz`;
  const unpacked = await fs.mkdtemp(path.join(f.dir, 'desktop-archive-'));
  const executable = platform === 'macos' ? 'Velron Status.app/Contents/MacOS/Velron Status' : 'velron-status';
  await fs.mkdir(path.dirname(path.join(unpacked, executable)), { recursive: true });
  await fs.writeFile(path.join(unpacked, executable), content, { mode: 0o755 });
  // Exercise the internal framework symlinks used by macOS packages on both OSes.
  await fs.mkdir(path.join(unpacked, 'framework/Versions/A'), { recursive: true });
  await fs.writeFile(path.join(unpacked, 'framework/Versions/A/data'), 'framework');
  await fs.symlink(unsafeLink ? '../../../escape' : 'A', path.join(unpacked, 'framework/Versions/Current'));
  await fs.symlink('Versions/Current/data', path.join(unpacked, 'framework/data'));
  const archive = path.join(f.downloads, name);
  await exec('tar', ['-czf', archive, '-C', unpacked, '.']);
  const hash = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await fs.writeFile(path.join(f.downloads, 'SHA256SUMS-desktop.txt'), `${hash}  ${name}\n`);
  return { hash, name, executable };
}

test('optional desktop installs privately without changing Server or Client launchers and preserves older versions', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await f.run();
  const existing = ['velron', 'velron-client'].map(name => path.join(f.options.commandDir, name));
  const before = await Promise.all(existing.map(file => fs.readFile(file, 'utf8')));
  const first = await desktopArchive(f);
  const { stdout } = await f.run({}, { DISPLAY: ':99' });
  assert.match(stdout, /Installed the Velron status window/);
  const root = path.join(f.options.velronHome, 'desktop');
  const descriptor = JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8'));
  assert.deepEqual(descriptor, { schemaVersion: 1, executable: path.join(root, first.hash, first.executable) });
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(root, 'status.json'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(root, first.hash, 'framework/data'), 'utf8'), 'framework');
  assert.deepEqual(await Promise.all(existing.map(file => fs.readFile(file, 'utf8'))), before);
  const second = await desktopArchive(f, { content: '#!/bin/sh\n# new status build\nexit 0\n' });
  await f.run({}, { DISPLAY: ':99' });
  assert.notEqual(first.hash, second.hash);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8')).executable, path.join(root, second.hash, second.executable));
  assert.equal(await fs.readFile(descriptor.executable, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.deepEqual((await fs.readdir(root)).sort(), [first.hash, second.hash, 'status.json'].sort());
});

test('missing desktop assets and checksum mismatch preserve the previous UI and normal installation success', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const archive = await desktopArchive(f);
  await f.run({}, { DISPLAY: ':99' });
  const descriptor = path.join(f.options.velronHome, 'desktop/status.json');
  const before = await fs.readFile(descriptor, 'utf8');
  await fs.rm(path.join(f.downloads, 'SHA256SUMS-desktop.txt'));
  let result = await f.run({}, { DISPLAY: ':99' });
  assert.match(result.stdout, /optional status window could not be installed/);
  assert.match(result.stdout, /VELRON_INSTALL_STAGE:complete/);
  assert.equal(await fs.readFile(descriptor, 'utf8'), before);
  await fs.writeFile(path.join(f.downloads, 'SHA256SUMS-desktop.txt'), `${'0'.repeat(64)}  ${archive.name}\n`);
  result = await f.run({}, { DISPLAY: ':99' });
  assert.match(result.stdout, /Status window archive checksum did not match/);
  assert.match(result.stdout, /VELRON_INSTALL_STAGE:complete/);
  assert.equal(await fs.readFile(descriptor, 'utf8'), before);
});

test('desktop archive link traversal is rejected before extraction while verified Server installation continues', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await desktopArchive(f, { unsafeLink: true });
  const { stdout } = await f.run({}, { DISPLAY: ':99' });
  assert.match(stdout, /optional status window could not be installed/);
  assert.match(stdout, /VELRON_INSTALL_STAGE:complete/);
  await assert.rejects(fs.stat(path.join(f.options.velronHome, 'desktop/status.json')));
  assert.equal((await exec(path.join(f.options.commandDir, 'velron'))).stdout.trim(), 'fake binary');
});

test('Linux headless and Client-only installs skip desktop assets', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  const headless = await f.run({ components: 'server' });
  assert.match(headless.stdout, /No desktop session detected/);
  assert.doesNotMatch(headless.stdout, /Downloading the optional Velron/);
  const client = await f.run({ components: 'client' }, { DISPLAY: ':99' });
  assert.doesNotMatch(client.stdout, /Downloading the optional Velron/);
  await assert.rejects(fs.stat(path.join(f.options.velronHome, 'desktop')));
});

test('a ready user service can show the observer from the Installer desktop without changing its service environment', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  const listener = require('node:net').createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  await f.run({ components: 'server', keepConfig: false, httpPort: port });
  const pidFile = path.join(f.dir, 'service.pid');
  const argsFile = path.join(f.dir, 'status-args.json');
  const environmentFile = path.join(f.dir, 'installer-environment');
  const configFile = path.join(f.options.velronHome, 'config.json');
  const configBefore = await fs.readFile(configFile, 'utf8');
  const instanceId = '8e951d33-9605-440c-af06-2357de2c38dc';
  const program = `#!${process.execPath}\nconst fs=require('node:fs');const home=process.env.VELRON_HOME;const config=JSON.parse(fs.readFileSync(home+'/config.json'));fs.writeFileSync(process.env.FAKE_SERVER_PID,String(process.pid));fs.writeFileSync(home+'/server-instance.lock',JSON.stringify({schemaVersion:2,pid:process.pid,instanceId:'${instanceId}',guardFileName:'server-instance.guard.sqlite'}));require('node:http').createServer((request,response)=>{response.writeHead(401);response.end(JSON.stringify({error:{code:'management_authentication_required'}}));}).listen(config.port,config.host);\n`;
  const name = `velron-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  await fs.writeFile(path.join(f.downloads, name), program);
  await fs.writeFile(path.join(f.downloads, 'SHA256SUMS.txt'), `${crypto.createHash('sha256').update(program).digest('hex')}  ${name}\n`);
  await desktopArchive(f, { content: `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.FAKE_STATUS_ARGS,JSON.stringify({args:process.argv.slice(2),display:process.env.DISPLAY,unsafeEnvironment:Object.keys(process.env).filter(name=>/^(NODE_OPTIONS|NODE_PATH|ELECTRON_.*)$/i.test(name))}));\n` });
  await fs.writeFile(path.join(f.bin, 'systemctl'), '#!/bin/sh\nif [ "$1 $2" = "--user restart" ]; then\n env -u DISPLAY -u WAYLAND_DISPLAY nohup "$FAKE_SERVER_COMMAND" >"$FAKE_SERVER_LOG" 2>&1 &\nfi\nexit 0\n', { mode: 0o755 });
  const realCurl = (await exec('/bin/sh', ['-c', 'command -v curl'])).stdout.trim();
  const fakeCurl = path.join(f.bin, 'curl');
  await fs.writeFile(fakeCurl, (await fs.readFile(fakeCurl, 'utf8')).replace('#!/bin/sh\n', '#!/bin/sh\nfor arg in "$@"; do\n case "$arg" in http://*) exec "$FAKE_REAL_CURL" "$@";; esac\ndone\n'));
  try {
    const env = { ...f.env, ...toEnvironment({ ...f.options, components: 'server', autostart: true, startNow: true }),
      DISPLAY: ':99', CI: '', SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '', FAKE_REAL_CURL: realCurl, FAKE_SERVER_PID: pidFile,
      FAKE_STATUS_ARGS: argsFile, FAKE_SERVER_COMMAND: path.join(f.options.commandDir, 'velron'), FAKE_SERVER_LOG: path.join(f.dir, 'service.log'),
      FAKE_INSTALLER_ENV: environmentFile, NODE_OPTIONS: '--no-warnings', NODE_PATH: f.dir,
      ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', ELECTRON_ENABLE_LOGGING: '1', electron_custom_flag: 'preserved-in-parent',
    };
    // Source the real engine so the same Installer shell can report only the
    // synthetic flags after the observer subshell has finished.
    const { stdout } = await exec('/bin/sh', ['-c', 'installer_script=$1; shift; . "$installer_script"; printf "%s\\n" "$NODE_OPTIONS" "$NODE_PATH" "$ELECTRON_RUN_AS_NODE" "$ELECTRON_NO_ASAR" "$ELECTRON_ENABLE_LOGGING" "$electron_custom_flag" >"$FAKE_INSTALLER_ENV"', 'test', engine, '--non-interactive'], {
      env, timeout: 20000, maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, /authentication is ready/);
    assert.match(stdout, /VELRON_INSTALL_STAGE:complete/);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await fs.stat(argsFile).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const observed = JSON.parse(await fs.readFile(argsFile, 'utf8'));
    assert.equal(observed.display, ':99');
    assert.deepEqual(observed.unsafeEnvironment, []);
    assert.equal(await fs.readFile(environmentFile, 'utf8'), `--no-warnings\n${f.dir}\n1\n1\n1\npreserved-in-parent\n`);
    assert.equal(await fs.readFile(configFile, 'utf8'), configBefore);
    assert.deepEqual(observed.args, ['--velron-home', f.options.velronHome, '--server-pid', (await fs.readFile(pidFile, 'utf8')).trim(),
      '--instance-id', instanceId, '--server-host', '127.0.0.1', '--server-port', String(port)]);
    const service = await fs.readFile(path.join(f.env.XDG_CONFIG_HOME, 'systemd/user/velron.service'), 'utf8');
    assert.doesNotMatch(service, /DISPLAY|WAYLAND|velron-status|Velron Status/);
  } finally {
    const pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => '0'));
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
});

test('CI and SSH client sessions suppress the service observer even with a forwarded display', { skip: process.platform === 'win32' }, async () => {
  const source = await fs.readFile(engine, 'utf8');
  const helper = source.match(/^show_service_desktop_status\(\) \([\s\S]*?^\)/m)?.[0];
  assert.ok(helper);
  for (const session of [{ CI: 'true', SSH_CLIENT: '' }, { CI: '', SSH_CLIENT: '127.0.0.1 1234 22' }]) {
    // TEMP_DIR is deliberately absent: a skipped observer must return before
    // reading local executable/marker files or attempting any process launch.
    await exec('/bin/sh', ['-eu', '-c', `${helper}\nshow_service_desktop_status\n`], {
      env: { ...process.env, AUTOSTART_KIND: 'systemd', OS_NAME: 'linux', DISPLAY: ':99',
        TEMP_DIR: undefined, SSH_CONNECTION: '', SSH_TTY: '', ...session },
    });
  }
});
