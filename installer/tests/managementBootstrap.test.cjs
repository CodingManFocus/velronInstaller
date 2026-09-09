const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { localManagementUrl, assertManagementReady, readManagementToken, openInstalledServer } = require('../app/managementBootstrap.cjs');

const token = 'a'.repeat(43);
function readyResponse() {
  return new Response(JSON.stringify({ error: { code: 'management_authentication_required' } }), {
    status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="velron-management"' },
  });
}

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'velron-bootstrap-'));
  const velronHome = path.join(home, '.velron');
  await fs.mkdir(velronHome, { mode: 0o700 });
  await fs.writeFile(path.join(velronHome, 'management-token'), token + '\n', { mode: 0o600 });
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { options: { velronHome, commandDir: path.join(home, 'bin'), serverHost: '127.0.0.1', httpPort: 4141 },
    tokenOptions: { home } };
}

test('credential bootstrap targets numeric loopback only, including IPv6 wildcard binding', () => {
  for (const [host, expected] of [['localhost', '127.0.0.1'], ['LOCALHOST', '127.0.0.1'], ['0.0.0.0', '127.0.0.1'],
    ['127.0.0.2', '127.0.0.2'], ['::', '[::1]'], ['0:0:0:0:0:0:0:1', '[::1]']]) {
    assert.equal(localManagementUrl(host, 4141).hostname, expected);
  }
  for (const host of ['example.com', '192.168.0.1', '127.example.com', '[::1]', '127.0.0.1:9000']) {
    assert.throws(() => localManagementUrl(host, 4141), /loopback/);
  }
});

test('Open Velron checks readiness without credentials then opens the local fragment token', async t => {
  const { options, tokenOptions } = await fixture(t);
  let opened;
  await openInstalledServer(options, { tokenOptions, fetcher: async (url, init) => {
    assert.equal(url.href, 'http://127.0.0.1:4141/api/health');
    assert.equal(url.hash, '');
    assert.equal(init.headers, undefined);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    return readyResponse();
  }, openExternal: async url => { opened = new URL(url); } });
  assert.equal(opened.origin, 'http://127.0.0.1:4141');
  assert.equal(opened.search, '');
  assert.equal(opened.hash, '#managementToken=' + token);
});

test('unexpected health responses do not read or hand off a token', async () => {
  for (const response of [new Response('{}'), new Response('{}', { status: 401 }),
    new Response('x'.repeat(5000), { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="velron-management"' } })]) {
    await assert.rejects(openInstalledServer({ serverHost: '127.0.0.1', httpPort: 4141 }, {
      fetcher: async () => response,
      openExternal: async () => assert.fail('Must not open browser'),
    }), /not ready/);
  }
});

test('redirects are refused and stalled health response bodies time out', async t => {
  let redirected = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect-target') { redirected++; response.end('unexpected'); return; }
    if (request.headers['x-fixture'] === 'redirect') {
      response.writeHead(302, { Location: '/redirect-target' }); response.end(); return;
    }
    response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="velron-management"' });
    response.write('{');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = new URL(`http://127.0.0.1:${server.address().port}/`);
  await assert.rejects(assertManagementReady(url, { timeoutMs: 100,
    fetcher: (target, init) => fetch(target, { ...init, headers: { 'X-Fixture': 'redirect' } }),
  }), /not ready/);
  assert.equal(redirected, 0);
  await assert.rejects(assertManagementReady(url, { timeoutMs: 100 }), /not ready/);
});

test('missing, nonprivate and symlink token files are refused with actionable secret-free errors', async t => {
  const { options, tokenOptions } = await fixture(t);
  const tokenPath = path.join(options.velronHome, 'management-token');
  assert.equal(await readManagementToken(options, tokenOptions), token);
  if (process.platform !== 'win32') {
    await fs.chmod(tokenPath, 0o644);
    await assert.rejects(readManagementToken(options, tokenOptions), /owner-only/);
    await fs.unlink(tokenPath);
    const outside = path.join(tokenOptions.home, 'outside-token');
    await fs.writeFile(outside, token, { mode: 0o600 });
    await fs.symlink(outside, tokenPath);
    await assert.rejects(readManagementToken(options, tokenOptions), /owner-only/);
  }
  await fs.unlink(tokenPath);
  await assert.rejects(readManagementToken(options, tokenOptions), error => {
    assert.ok(error.message.includes(tokenPath));
    assert.ok(!error.message.includes(token));
    return true;
  });
});

test('browser launch errors cannot return the management token through IPC', async t => {
  const { options, tokenOptions } = await fixture(t);
  await assert.rejects(openInstalledServer(options, { tokenOptions, fetcher: async () => readyResponse(),
    openExternal: async url => { throw new Error('Failed to launch ' + url); },
  }), error => {
    assert.ok(error.message.includes('default browser'));
    assert.ok(!error.message.includes(token));
    assert.ok(!error.message.includes('managementToken'));
    return true;
  });
});
