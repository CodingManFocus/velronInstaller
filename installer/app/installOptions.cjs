const os = require('node:os');
const path = require('node:path');
const { isBindHost, isAllowedHost } = require('./serverSettings.cjs');
const { assertDedicatedStatePath } = require('./installPaths.cjs');

const fields = ['components', 'velronHome', 'commandDir', 'keepConfig', 'serverHost', 'httpPort',
  'vcpPort', 'allowedHosts', 'autostart', 'startNow', 'connection', 'vcpUrl', 'vcpToken', 'integration'];

function getDefaults(platform = process.platform, home = os.homedir(), env = process.env) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return {
    components: 'both', velronHome: paths.join(home, '.velron'),
    commandDir: platform === 'win32'
      ? paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'Programs', 'Velron', 'bin')
      : paths.join(home, '.local', 'bin'),
    keepConfig: true, serverHost: '127.0.0.1', httpPort: 4141, vcpPort: 4143, allowedHosts: '',
    autostart: true, startNow: true, connection: 'local', vcpUrl: '', vcpToken: '', integration: 'codex',
  };
}

function validateOptions(input, platform = process.platform, { home = os.homedir(), cwd = process.cwd() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid installation settings.');
  if (Object.keys(input).some(key => !fields.includes(key))) throw new Error('Unknown installation setting.');
  if (input.components === 'client') input = { ...input, serverHost: '127.0.0.1', httpPort: 4141,
    vcpPort: 4143, allowedHosts: '', autostart: false, startNow: false };
  const options = {};
  for (const key of fields) {
    const value = input[key];
    if (['keepConfig', 'autostart', 'startNow'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`Invalid ${key}.`);
    } else if (['httpPort', 'vcpPort'].includes(key)) {
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Ports must be integers from 1 to 65535.');
    } else if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`Invalid ${key}.`);
    }
    options[key] = value;
  }
  for (const [key, values] of Object.entries({ components: ['both', 'server', 'client'],
    connection: ['local', 'remote'], integration: ['codex', 'claude', 'both', 'other'] })) {
    if (!values.includes(options[key])) throw new Error(`Invalid ${key}.`);
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  for (const key of ['velronHome', 'commandDir']) {
    options[key] = options[key].trim();
    if (!paths.isAbsolute(options[key]) || (platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(options[key]))) {
      throw new Error('Choose an absolute installation path.');
    }
    options[key] = paths.normalize(options[key]);
    if (platform === 'win32' && /[%"<>|?*]/.test(options[key])) throw new Error('This Windows path contains unsupported characters.');
  }
  assertDedicatedStatePath(options.velronHome, { platform, home, cwd, commandDir: options.commandDir });
  if (options.components !== 'client') {
    if (!isBindHost(options.serverHost)) throw new Error('Enter an IP address or DNS hostname without a scheme, path, port or IPv6 brackets.');
    options.serverHost = options.serverHost.trim();
    if (options.httpPort === options.vcpPort) throw new Error('HTTP and VCP ports must differ.');
    const allowedHosts = options.allowedHosts.split(',').map(host => host.trim()).filter(Boolean);
    if (allowedHosts.length > 256 || allowedHosts.some(host => !isAllowedHost(host))) {
      throw new Error('Enter allowed hostnames separated by commas.');
    }
    options.allowedHosts = [...new Set(allowedHosts.map(host => host.toLowerCase()))].join(',');
  }
  if (options.components !== 'server' && options.connection === 'remote') {
    let url;
    try { url = new URL(options.vcpUrl); } catch { throw new Error('Enter a valid remote VCP URL.'); }
    if (url.protocol !== 'wss:' || !url.hostname || url.pathname !== '/vcp/v1' || url.username || url.password || url.search || url.hash || /[?#]/.test(options.vcpUrl)) {
      throw new Error('Use wss://host:port/vcp/v1 without credentials, query, or fragment.');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(options.vcpToken)) throw new Error('Enter the 43-character VCP access token.');
  } else {
    options.vcpToken = '';
    options.vcpUrl = '';
    options.connection = 'local';
  }
  return options;
}

function toEnvironment(options) {
  const values = { COMPONENTS: options.components, HOME: options.velronHome, COMMAND_DIR: options.commandDir,
    KEEP_CONFIG: options.keepConfig, SERVER_HOST: options.serverHost, HTTP_PORT: options.httpPort,
    VCP_PORT: options.vcpPort, ALLOWED_HOSTS: options.allowedHosts, AUTOSTART: options.autostart,
    START_NOW: options.startNow, CONNECTION: options.connection, VCP_URL: options.vcpUrl,
    VCP_TOKEN: options.vcpToken, INTEGRATION: options.integration };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [`VELRON_INSTALL_${key}`, String(value)]));
}

module.exports = { getDefaults, validateOptions, toEnvironment };
