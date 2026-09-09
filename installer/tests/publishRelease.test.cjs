const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { installerFiles, prepareReleaseFiles } = require('../scripts/prepareReleaseFiles.cjs');
const { publishRelease } = require('../scripts/publishRelease.cjs');

async function fixture(t, changes = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'velron-release-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of installerFiles) await fs.writeFile(path.join(directory, name), `Build: ${name}`);
  const env = { GITHUB_REPOSITORY: 'CodingManFocus/velronInstaller', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'test-token' };
  const calls = [];
  const uploaded = [];
  let mainReads = 0;
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url);
    const json = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method, json });
    const reply = value => ({ ok: true, json: async () => value });
    if (endpoint.pathname.endsWith('/git/ref/heads/main')) {
      mainReads++;
      return reply({ object: { sha: changes.stale || (changes.staleAfterUpload && mainReads > 1) ? 'b'.repeat(40) : env.GITHUB_SHA } });
    }
    if (options.method === 'POST' && endpoint.pathname.endsWith('/releases')) {
      return reply({ id: 42, upload_url: 'https://uploads.github.com/repos/CodingManFocus/velronInstaller/releases/42/assets{?name,label}' });
    }
    if (endpoint.hostname === 'uploads.github.com') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const name = endpoint.searchParams.get('name');
      uploaded.push({ name, bytes, id: uploaded.length + 1 });
      if (changes.failUpload === name) return { ok: false, status: 502 };
      return reply({});
    }
    if (endpoint.pathname.endsWith('/releases/42/assets')) {
      const assets = uploaded.map(({ name, bytes, id }) => ({ id, name, size: bytes.length, state: 'uploaded',
        digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` }));
      if (changes.missingRemoteAsset) assets.pop();
      if (changes.duplicateRemoteAsset) assets[4] = assets[0];
      return reply(assets);
    }
    const match = endpoint.pathname.match(/\/releases\/assets\/(\d+)$/);
    if (match) {
      const asset = uploaded.find(item => item.id === Number(match[1]));
      return { ok: true, body: Readable.from([changes.corrupt === asset.name ? Buffer.from('corrupt') : asset.bytes]) };
    }
    if (options.method === 'PATCH' && endpoint.pathname.endsWith('/releases/42')) {
      const creation = calls.find(call => call.method === 'POST' && call.json);
      return reply({ draft: false, tag_name: creation.json.tag_name, html_url: 'https://github.com/CodingManFocus/velronInstaller/releases/tag/test' });
    }
    throw new Error(`Unexpected request: ${options.method} ${url}`);
  };
  return { directory, env, fetchImpl, calls, uploaded,
    run: () => publishRelease({ directory, env, fetchImpl }) };
}

test('publishes Latest only after uploading and reading back all four builds and their checksum manifest', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(f.uploaded.length, 5);
  const creation = f.calls.find(call => call.method === 'POST' && call.json).json;
  assert.equal(creation.draft, true);
  assert.equal(creation.target_commitish, f.env.GITHUB_SHA);
  assert.equal(creation.make_latest, 'false');
  assert.equal(result.tag, `installer-${f.env.GITHUB_SHA}-123-1`);
  assert.equal(f.calls.filter(call => /\/releases\/assets\//.test(call.url)).length, 5);
  assert.deepEqual(f.calls.at(-1).json, { draft: false, prerelease: false, make_latest: 'true' });
  const manifest = f.uploaded.find(asset => asset.name === 'SHA256SUMS-installers.txt').bytes.toString();
  for (const asset of f.uploaded.slice(0, 4)) {
    assert.ok(manifest.includes(`${crypto.createHash('sha256').update(asset.bytes).digest('hex')}  ${asset.name}\n`));
  }
});

test('incomplete and empty local builds cannot create a draft', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.directory, installerFiles[0]));
  await assert.rejects(f.run(), /ENOENT/);
  assert.equal(f.calls.length, 0);
  await fs.writeFile(path.join(f.directory, installerFiles[0]), '');
  await assert.rejects(f.run(), /non-empty regular file/);
  assert.equal(f.calls.length, 0);
});

test('checksum generation rejects directories in place of expected installers', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.directory, installerFiles[0]));
  await fs.mkdir(path.join(f.directory, installerFiles[0]));
  await assert.rejects(prepareReleaseFiles(f.directory), /non-empty regular file/);
});

for (const [name, changes] of Object.entries({
  'failed upload': { failUpload: installerFiles[1] },
  'missing remote asset': { missingRemoteAsset: true },
  'duplicate remote asset': { duplicateRemoteAsset: true },
  'corrupted remote build': { corrupt: installerFiles[2] },
  'corrupted remote manifest': { corrupt: 'SHA256SUMS-installers.txt' },
})) {
  test(`${name} leaves the release unpublished`, async t => {
    const f = await fixture(t, changes);
    await assert.rejects(f.run());
    assert.ok(f.calls.some(call => call.method === 'POST'));
    assert.ok(!f.calls.some(call => call.method === 'PATCH'));
  });
}

test('an older source commit cannot replace Latest', async t => {
  const f = await fixture(t, { stale: true });
  assert.equal((await f.run()).skipped, true);
  assert.ok(!f.calls.some(call => call.method === 'POST'));
});

test('a main update during upload leaves the verified release as a draft', async t => {
  const f = await fixture(t, { staleAfterUpload: true });
  assert.equal((await f.run()).skipped, true);
  assert.equal(f.uploaded.length, 5);
  assert.ok(!f.calls.some(call => call.method === 'PATCH'));
});

test('publication rejects the payload repository, pull requests and non-main refs', async t => {
  for (const patch of [{ GITHUB_REPOSITORY: 'CodingManFocus/velronRelease' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }]) {
    const f = await fixture(t);
    Object.assign(f.env, patch);
    await assert.rejects(f.run(), /only from main/);
    assert.equal(f.calls.length, 0);
  }
});
