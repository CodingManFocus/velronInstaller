const { fileURLToPath } = require('node:url');

function isInstallerPage(actualUrl, expectedUrl, { windows = process.platform === 'win32' } = {}) {
  if (typeof actualUrl !== 'string' || /[?#]/.test(actualUrl)) return false;
  try {
    // Node and Chromium can serialize the same filename differently (~ / %7E).
    // Compare decoded file paths, not URL spellings. fileURLToPath also rejects
    // non-file schemes, malformed escapes, and encoded Windows separators.
    return fileURLToPath(actualUrl, { windows }) === fileURLToPath(expectedUrl, { windows });
  } catch { return false; }
}

module.exports = { isInstallerPage };
