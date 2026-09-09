const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { validateFilesystemOptions } = require('./installPaths.cjs');

function localManagementUrl(host, port) {
  host = typeof host === 'string' ? host.trim().toLowerCase() : '';
  let browserHost;
  if (host === 'localhost' || host === '0.0.0.0') browserHost = '127.0.0.1';
  else if (isIP(host) === 4 && host.startsWith('127.')) browserHost = host;
  else if (isIP(host) === 6) {
    const normalized = new URL(`http://[${host}]`).hostname;
    if (normalized === '[::]' || normalized === '[::1]') browserHost = '[::1]';
  }
  if (!browserHost) {
    throw new Error('Automatic sign-in requires Server to listen on a loopback address. Set host in config.json to 127.0.0.1, localhost, 0.0.0.0, ::1 or :: and restart Server.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The Server HTTP port is invalid.');
  return new URL(`http://${browserHost}:${port}/`);
}

async function assertManagementReady(url, { fetcher = fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // No credentials in the readiness probe, and never follow a redirect.
    const response = await fetcher(new URL('/api/health', url), {
      redirect: 'error', signal: controller.signal, credentials: 'omit',
    });
    if (response.status !== 401 || response.headers.get('www-authenticate') !== 'Bearer realm="velron-management"') {
      await response.body?.cancel();
      throw new Error('Unexpected management response.');
    }
    // Bound the entire body read as well as the initial response.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing management response.');
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4096) throw new Error('Unexpected management response.');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error?.code !== 'management_authentication_required') {
      throw new Error('Unexpected management response.');
    }
  } catch {
    throw new Error('Velron Server is not ready for local sign-in. Check that Server is running and the configured HTTP port is available, then try Open Velron again.');
  } finally {
    clearTimeout(timer);
  }
}

async function readManagementToken(options, { platform = process.platform, fileSystem = fs,
  uid = process.getuid?.(), home, cwd } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const tokenPath = paths.join(options.velronHome, 'management-token');
  let file;
  try {
    await validateFilesystemOptions(options, { platform, home, cwd, realpath: fileSystem.realpath });
    const directoryStat = await fileSystem.stat(options.velronHome);
    if (!directoryStat.isDirectory() || (platform !== 'win32' &&
      (directoryStat.uid !== uid || (directoryStat.mode & 0o077) !== 0))) throw new Error('Unsafe directory.');
    const entry = await fileSystem.lstat(tokenPath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe token file.');
    file = await fileSystem.open(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 43 || stat.size > 128 ||
      stat.ino !== entry.ino || stat.dev !== entry.dev ||
      (platform !== 'win32' && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
      throw new Error('Unsafe token file.');
    }
    const buffer = Buffer.alloc(129);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid token file.');
    return token;
  } catch {
    throw new Error(`The local sign-in token could not be read safely. Restart Velron Server to regenerate the owner-only token file: ${tokenPath}`);
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function openInstalledServer(options, { openExternal, fetcher, timeoutMs,
  tokenOptions } = {}) {
  const url = localManagementUrl(options.serverHost, options.httpPort);
  await assertManagementReady(url, { fetcher, timeoutMs });
  const token = await readManagementToken(options, tokenOptions);
  url.hash = `managementToken=${encodeURIComponent(token)}`;
  try {
    await openExternal(url.href);
  } catch {
    // Electron's underlying error may include its URL. Never forward that secret to IPC/logs.
    throw new Error('The browser could not be opened. Set a default browser and try Open Velron again.');
  }
}

module.exports = { localManagementUrl, assertManagementReady, readManagementToken, openInstalledServer };
