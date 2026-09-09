const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { toEnvironment } = require('./installOptions.cjs');

function createInstallRunner({ engineDir, onEvent, platform = process.platform, spawnProcess = spawn, environment = process.env }) {
  let child = null;
  let cancelRequested = false;
  let logs = [];
  let warnings = [];
  let secret = '';
  let killTimer;

  function emitLine(value) {
    const clean = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    const line = secret ? clean.split(secret).join('[redacted]') : clean;
    if (!line) return;
    const stage = /^VELRON_INSTALL_STAGE:(download|server|client|configure|integrate|startup|complete)$/.exec(line);
    if (stage) { onEvent({ type: 'stage', stage: stage[1] }); return; }
    const clipped = line.slice(0, 4000);
    logs.push(clipped);
    if (logs.length > 600) logs.shift();
    if (/^! /.test(line)) warnings.push(clipped);
    onEvent({ type: 'log', line: clipped });
  }

  return {
    get running() { return child !== null; },
    get logs() { return logs.join('\n'); },
    run(options) {
      if (child) throw new Error('An installation is already running.');
      logs = [];
      warnings = [];
      secret = options.vcpToken;
      cancelRequested = false;
      const windows = platform === 'win32';
      const targetPaths = windows ? path.win32 : path.posix;
      if (windows && !environment.SystemRoot) throw new Error('Windows PowerShell could not be located.');
      const command = windows ? path.win32.join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
      const args = windows
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', targetPaths.join(engineDir, 'install.ps1'), '-NonInteractive']
        : [targetPaths.join(engineDir, 'install.sh'), '--non-interactive'];
      // Remove obsolete installer options inherited from an outer process.
      const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('VELRON_INSTALL_')));
      Object.assign(env, toEnvironment(options), { NO_COLOR: '1', TERM: 'dumb' });
      return new Promise(resolve => {
        child = spawnProcess(command, args, { env, cwd: engineDir, windowsHide: true,
          shell: false, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [child.stdout, child.stderr]) {
          stream.setEncoding('utf8');
          readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', emitLine);
        }
        let finished = false;
        function finish(code, error) {
          if (finished) return;
          finished = true;
          clearTimeout(killTimer);
          if (error) emitLine(error.message);
          const result = { status: cancelRequested ? 'cancelled' : code === 0 ? 'success' : 'failed',
            exitCode: code, warnings: [...warnings] };
          child = null;
          secret = '';
          onEvent({ type: 'result', ...result });
          resolve(result);
        }
        child.once('error', error => finish(null, error));
        child.once('close', code => finish(code));
      });
    },
    cancel() {
      if (!child) return;
      cancelRequested = true;
      const pid = child.pid;
      if (platform === 'win32') {
        const killer = spawnProcess(path.win32.join(environment.SystemRoot, 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', error => emitLine(error.message));
      } else if (pid) {
        try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') emitLine(error.message); }
        killTimer = setTimeout(() => {
          if (!child || child.pid !== pid) return;
          try { process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ }
        }, 4000);
        killTimer.unref();
      }
    },
  };
}

module.exports = { createInstallRunner };
