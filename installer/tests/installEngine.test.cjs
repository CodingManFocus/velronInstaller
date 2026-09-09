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
    XDG_CONFIG_HOME: path.join(dir, 'config'), FAKE_DOWNLOADS: downloads, FAKE_HOST_CALLS: path.join(dir, 'host-calls'), NO_COLOR: '1' };
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
