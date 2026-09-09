const { isIP } = require('node:net');

// Keep this contract aligned with Velron's serverSettings/serverSettings.ts.
function isDnsHostname(value) {
  return value.length >= 1 && value.length <= 253 && !value.endsWith('.') &&
    value.split('.').every(label => label.length >= 1 && label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function isBindHost(value) {
  return typeof value === 'string' && value.trim().length <= 253 &&
    (isIP(value.trim()) !== 0 || isDnsHostname(value.trim()));
}

function isAllowedHost(value) {
  if (typeof value !== 'string' || value.trim().length > 253) return false;
  const normalized = value.trim();
  const bracketed = /^\[([^\]]+)\]$/.exec(normalized);
  return bracketed ? isIP(bracketed[1]) === 6 : isBindHost(normalized);
}

function isIntegerInRange(value, maximum) {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

function isServerSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = ['schemaVersion', 'host', 'port', 'localVcpPort', 'allowedHosts',
    'managementSecureCookies', 'maxConcurrentRuns', 'maxRunStartsPerMinute', 'maxRunContextBytes'];
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)) &&
    value.schemaVersion === 1 && isBindHost(value.host) &&
    isIntegerInRange(value.port, 65535) && isIntegerInRange(value.localVcpPort, 65535) &&
    value.port !== value.localVcpPort &&
    Array.isArray(value.allowedHosts) && value.allowedHosts.length <= 256 && value.allowedHosts.every(isAllowedHost) &&
    typeof value.managementSecureCookies === 'boolean' &&
    isIntegerInRange(value.maxConcurrentRuns, 1000) &&
    isIntegerInRange(value.maxRunStartsPerMinute, 100000) &&
    isIntegerInRange(value.maxRunContextBytes, 128 * 1024 * 1024);
}

module.exports = { isBindHost, isAllowedHost, isServerSettings };
