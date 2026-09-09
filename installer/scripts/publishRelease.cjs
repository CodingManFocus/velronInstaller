const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { installerFiles, prepareReleaseFiles } = require('./prepareReleaseFiles.cjs');

const repository = 'CodingManFocus/velronInstaller';
const checksumFile = 'SHA256SUMS-installers.txt';

async function sha256(stream) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/** Publish only complete, verified, uniquely tagged releases in this repository. */
async function publishRelease({ directory = 'dist', env = process.env, fetchImpl = fetch } = {}) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main'
      || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('Installer publication is allowed only from main in CodingManFocus/velronInstaller.');
  }
  const source = env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(source ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')
      || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !env.GH_TOKEN) {
    throw new Error('Missing or invalid GitHub Actions release context.');
  }

  // Validate all four builds before making any authenticated request or draft.
  await prepareReleaseFiles(directory);
  const files = [];
  for (const name of [...installerFiles, checksumFile]) {
    const filename = path.join(directory, name);
    files.push({ name, filename, size: fs.statSync(filename).size,
      hash: await sha256(fs.createReadStream(filename)) });
  }

  const base = `https://api.github.com/repos/${repository}`;
  async function request(url, { method = 'GET', json, stream, accept = 'application/vnd.github+json' } = {}) {
    const parsed = new URL(url);
    if (!['https://api.github.com', 'https://uploads.github.com'].includes(parsed.origin)
        || !parsed.pathname.startsWith(`/repos/${repository}/`)) {
      throw new Error('Refusing a release request outside the Installer repository.');
    }
    const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'velron-installer-release' };
    const options = { method, headers, signal: AbortSignal.timeout(10 * 60 * 1000) };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(json);
    } else if (stream) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = String(stream.size);
      options.body = fs.createReadStream(stream.filename);
      options.duplex = 'half';
    }
    const response = await fetchImpl(url, options);
    if (!response.ok) throw new Error(`GitHub ${method} ${parsed.pathname} failed (${response.status}).`);
    return response;
  }
  async function api(endpoint, options) { return (await request(`${base}/${endpoint}`, options)).json(); }
  async function isCurrentMain() { return (await api('git/ref/heads/main')).object.sha === source; }

  // Queued older builds must not replace a newer main revision's Latest release.
  if (!await isCurrentMain()) return { skipped: true, reason: 'A newer main commit is available.' };
  const tag = `installer-${source}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const version = require('../package.json').version;
  const release = await api('releases', { method: 'POST', json: {
    tag_name: tag, target_commitish: source, name: `Velron Installer ${version} (${source.slice(0, 7)})`,
    draft: true, prerelease: false, make_latest: 'false',
    body: `Desktop Installer for Windows, macOS, and Linux.\n\n`
      + `Source: ${source}\nBuild: https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}\n\n`
      + `All four installers are built from this commit and verified against SHA256SUMS-installers.txt.\n`
      + `The installation engines download Velron Server and Client from CodingManFocus/velronRelease.\n\n`
      + `Windows and macOS builds do not yet have a trusted publisher signature/notarization.\n`,
  } });
  const uploadBase = release.upload_url.replace(/\{.*$/, '');
  for (const file of files) {
    await request(`${uploadBase}?name=${encodeURIComponent(file.name)}`, { method: 'POST', stream: file });
  }

  const assets = await api(`releases/${release.id}/assets?per_page=100`);
  if (assets.length !== files.length) throw new Error('Draft does not contain exactly the five expected assets.');
  for (const file of files) {
    const matches = assets.filter(asset => asset.name === file.name);
    const asset = matches[0];
    if (matches.length !== 1 || asset.state !== 'uploaded' || asset.size !== file.size) {
      throw new Error(`Draft asset is missing or incomplete: ${file.name}`);
    }
    if (asset.digest && asset.digest !== `sha256:${file.hash}`) {
      throw new Error(`GitHub asset digest mismatch: ${file.name}`);
    }
    // Verify the actual remote bytes, including the manifest, before publishing.
    const response = await request(`${base}/releases/assets/${asset.id}`, { accept: 'application/octet-stream' });
    if (await sha256(response.body) !== file.hash) throw new Error(`Uploaded checksum mismatch: ${file.name}`);
  }
  if (!await isCurrentMain()) return { skipped: true, reason: 'Main changed during upload; the release remains a draft.' };
  const published = await api(`releases/${release.id}`, { method: 'PATCH', json: {
    draft: false, prerelease: false, make_latest: 'true',
  } });
  if (published.draft || published.tag_name !== tag) throw new Error('GitHub did not confirm release publication.');
  return { url: published.html_url, tag };
}

if (require.main === module) {
  publishRelease().then(
    result => console.log(result.skipped ? result.reason : `Published ${result.url}`),
    error => { console.error(error.message); process.exitCode = 1; },
  );
}

module.exports = { publishRelease };
