(() => {
  let stage = 'load-scripts';
  let complete = false;
  let failed = false;
  let metadata;
  const korean = (navigator.language || 'ko').startsWith('ko');
  const text = (ko, en) => korean ? ko : en;
  const redact = value => String(value)
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted-token]')
    .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:token|password|secret|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]');
  const labels = {
    'load-scripts': ['화면 스크립트 로딩', 'Loading UI scripts'],
    'preload-bridge': ['화면과 앱 연결', 'Connecting to the app'],
    'load-defaults': ['기본 설치 설정 불러오기', 'Loading installation defaults'],
    'subscribe-progress': ['진행 상황 연결', 'Subscribing to progress'],
    'render-wizard': ['첫 화면 표시', 'Rendering the wizard'],
  };
  const timeout = setTimeout(() => fail(new Error('STARTUP_TIMEOUT: initialization did not finish within 15 seconds.')), 15000);

  function fail(error) {
    if (complete || failed) return;
    failed = true;
    clearTimeout(timeout);
    const detail = redact(error?.stack || error?.message || error || 'Unknown startup error').slice(0, 12000);
    const report = [`Velron Installer startup failure`, `Time: ${new Date().toISOString()}`,
      `Stage: ${stage}`, `Version: ${metadata?.version || 'unavailable'}`,
      `Platform: ${metadata?.platform || navigator.platform} ${metadata?.arch || ''}`,
      `Page: ${location.href}`, '', detail].join('\n');
    console.error(report);
    const root = document.getElementById('app');
    root.className = 'startup-error';
    root.removeAttribute('aria-busy');
    root.replaceChildren();
    const heading = document.createElement('h1');
    heading.textContent = text('Installer를 시작하지 못했어요', 'The Installer could not start');
    const summary = document.createElement('p');
    summary.setAttribute('role', 'alert');
    summary.textContent = `${text('실패 단계', 'Failed stage')}: ${text(...(labels[stage] || [stage, stage]))} (${stage})`;
    const hint = document.createElement('p');
    hint.textContent = text('아래 진단 로그를 복사해서 전달해 주세요. 복사가 안 되면 로그를 선택해 Ctrl+C를 누르세요.', 'Copy the diagnostic log below and share it. If copying fails, select the log and press Ctrl+C.');
    const output = document.createElement('textarea');
    output.readOnly = true;
    output.className = 'startup-log';
    output.setAttribute('aria-label', text('진단 로그', 'Diagnostic log'));
    output.value = report;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'button primary';
    copy.textContent = text('진단 로그 복사', 'Copy diagnostic log');
    copy.addEventListener('click', async () => {
      try {
        if (window.velronInstaller?.copyStartupDiagnostics) await window.velronInstaller.copyStartupDiagnostics(output.value);
        else await navigator.clipboard.writeText(output.value);
        copy.textContent = text('복사했어요', 'Copied');
      } catch {
        output.focus(); output.select();
        copy.textContent = text('Ctrl+C로 복사해 주세요', 'Press Ctrl+C to copy');
      }
    });
    root.append(heading, summary, hint, output, copy);
    // The error screen and manual copy remain usable even if IPC is broken.
    try {
      const api = window.velronInstaller;
      if (api?.reportStartupFailure) {
        Promise.resolve(api.reportStartupFailure({ stage, detail: report })).then(saved => {
          if (typeof saved === 'string') output.value = saved;
        }).catch(() => {});
      }
    } catch { /* Original error stays visible. */ }
  }
  window.startupDiagnostics = {
    phase(value) { stage = value; },
    environment(value) { metadata = value; },
    get failed() { return failed; },
    ready() { complete = true; clearTimeout(timeout); },
    fail,
  };
  window.addEventListener('error', event => {
    fail(event.error || new Error(event.message || `Resource failed to load: ${event.target?.src || 'unknown'}`));
  });
  window.addEventListener('unhandledrejection', event => fail(event.reason));
})();
