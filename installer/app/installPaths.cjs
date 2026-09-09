const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function assertDedicatedStatePath(stateHome, { platform = process.platform, home = os.homedir(),
  cwd = process.cwd(), commandDir } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = value => platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  const state = normalize(stateHome);
  const forbidden = [paths.parse(state).root, home, cwd, commandDir].filter(Boolean).map(normalize);
  if (forbidden.includes(state)) {
    throw new Error('Choose a dedicated Velron data directory, separate from the filesystem root, user home, working directory and command directory.');
  }
  if (platform === 'win32') {
    const relationship = paths.relative(home, stateHome);
    if (!/^[A-Za-z]:\\$/.test(paths.parse(stateHome).root) || !/^[A-Za-z]:\\$/.test(paths.parse(home).root) ||
      !relationship || relationship === '..' || relationship.startsWith('..\\') || paths.isAbsolute(relationship)) {
      throw new Error('On Windows, choose a dedicated Velron data directory on a local drive inside your user profile.');
    }
  }
}

async function canonicalizeProspectivePath(value, paths, realpath) {
  try { return await realpath(value); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = paths.dirname(value);
    if (parent === value) throw error;
    return paths.join(await canonicalizeProspectivePath(parent, paths, realpath), paths.basename(value));
  }
}

async function validateFilesystemOptions(options, { platform = process.platform, home = os.homedir(),
  cwd = process.cwd(), realpath = fs.realpath } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const [stateHome, canonicalHome, canonicalCwd, commandDir] = await Promise.all(
    [options.velronHome, home, cwd, options.commandDir].map(value => canonicalizeProspectivePath(value, paths, realpath)),
  );
  assertDedicatedStatePath(stateHome, { platform, home: canonicalHome, cwd: canonicalCwd, commandDir });
}

module.exports = { assertDedicatedStatePath, validateFilesystemOptions };
