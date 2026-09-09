const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Never collect install options, configuration contents, or the environment.
function redact(value) {
  return String(value)
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted-token]')
    .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:token|password|secret|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]');
}

function createStartupDiagnostics({ directory, version, platform = process.platform, arch = process.arch, io = fs }) {
  const entries = [];
  const header = `Velron Installer ${version}\nOS: ${platform} ${os.release()} ${arch}\nElectron: ${process.versions.electron || 'unknown'}\nNode: ${process.versions.node}`;
  const file = path.join(directory, `startup-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`);
  let writeError = '';
  const report = () => `${header}\nLog file: ${file}${writeError ? `\nLog write failed: ${writeError}` : ''}\n\n${entries.join('\n\n')}`;
  function record(stage, error) {
    entries.push(redact(`[${new Date().toISOString()}] ${stage}\n${error?.stack || error?.message || error}`).slice(0, 12000));
    if (entries.length > 20) entries.shift();
    try {
      io.mkdirSync(directory, { recursive: true });
      writeError = '';
      io.writeFileSync(file, report(), { encoding: 'utf8', mode: 0o600 });
    } catch (error) { writeError = redact(error.message); }
    return report();
  }
  return { record, report, file };
}

module.exports = { createStartupDiagnostics, redact };
