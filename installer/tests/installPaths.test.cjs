const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateFilesystemOptions } = require('../app/installPaths.cjs');

test('state paths are checked after resolving existing symlink ancestors', async t => {
  if (process.platform === 'win32') return t.skip('POSIX symlink fixture');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'velron-path-contract-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.symlink(home, path.join(home, 'alias'));
  const options = { velronHome: path.join(home, 'alias'), commandDir: path.join(home, 'bin') };
  await assert.rejects(validateFilesystemOptions(options, { home }), /dedicated/);
  await validateFilesystemOptions({ ...options, velronHome: path.join(home, 'alias', 'new', '.velron') }, { home });
});

test('Windows canonical profile policy rejects junction escape before creating files', async () => {
  const home = 'C:\\Users\\Focus';
  const cwd = 'C:\\Installer';
  const map = new Map([[home, home], [cwd, cwd], [home + '\\bin', home + '\\bin'],
    [home + '\\junction', 'D:\\Shared']]);
  const realpath = async value => {
    if (map.has(value)) return map.get(value);
    throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
  };
  const options = { velronHome: home + '\\junction\\new-state', commandDir: home + '\\bin' };
  await assert.rejects(validateFilesystemOptions(options, { platform: 'win32', home, cwd, realpath }), /user profile/);
  await validateFilesystemOptions({ ...options, velronHome: home + '\\.velron' }, { platform: 'win32', home, cwd, realpath });
});
