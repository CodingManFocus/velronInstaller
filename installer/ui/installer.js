(() => {
  const api = window.velronInstaller;
  const root = document.getElementById('app');
  let options, environment;
  let language = 'ko';
  let step = 'components';
  let status = 'setup';
  let activeStage = 'download';
  let result = null;
  let config = { exists: false, valid: true };
  let errorText = '';
  let logs = [];
  let logOpen = false;
  let busy = false;

  const symbols = {
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
    check: '<path d="m5 12 4 4L19 6"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
    computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01m4-11h6m-6 11h6"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
    link: '<path d="m9 15 6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2m-3 5-2 2a5 5 0 0 1-7-7l2-2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-9h.01"/>',
    warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${symbols[name] || symbols.info}</svg>`;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const t = key => window.installerTranslations[language][key] || key;
  const hasServer = () => options.components !== 'client';
  const hasClient = () => options.components !== 'server';
  const steps = () => ['components', 'locations', ...(hasServer() ? ['server'] : []), ...(hasClient() ? ['client'] : []), 'review'];
  const phases = () => ['download', ...(hasServer() ? ['server'] : []), ...(hasClient() ? ['client'] : []), 'configure', ...(hasClient() ? ['integrate'] : []), ...(hasServer() ? ['startup'] : [])];
  const phaseTitle = phase => t({ server: 'serverDownload', client: 'clientDownload', startup: 'startupStage' }[phase] || phase);
  const note = (text, blue = false) => `<div class="note${blue ? ' blue' : ''}">${icon('info')}<p>${text}</p></div>`;
  const button = (action, text, primary = false, symbol = '') => `<button type="button" class="button${primary ? ' primary' : ''}" data-action="${action}"${busy ? ' disabled' : ''}>${text}${symbol ? icon(symbol) : ''}</button>`;

  function field(name, label, hint, type = 'text', placeholder = '', disabled = false) {
    return `<label class="field"><span class="field-label">${t(label)}</span><input class="input" name="${name}" type="${type}" value="${escape(options[name])}" placeholder="${escape(placeholder)}" ${disabled ? 'disabled' : ''} ${type === 'number' ? 'min="1" max="65535" step="1"' : ''} autocomplete="off" spellcheck="false">${hint ? `<span class="field-hint">${t(hint)}</span>` : ''}</label>`;
  }

  function toggle(name, label, hint) {
    return `<label class="toggle-row"><span><span class="toggle-title">${t(label)}</span><span class="toggle-hint">${t(hint)}</span></span><input class="toggle" name="${name}" type="checkbox" ${options[name] ? 'checked' : ''}></label>`;
  }

  function heading(title, description, resultIcon = '') {
    return `<div class="page-heading">${resultIcon ? `<div class="result-icon${resultIcon === 'warning' ? ' failure' : ''}">${icon(resultIcon)}</div>` : `<div class="eyebrow">${status === 'setup' ? `${t('step')} ${String(steps().indexOf(step) + 1).padStart(2, '0')} / ${String(steps().length).padStart(2, '0')}` : 'VELRON SETUP'}</div>`}<h1 tabindex="-1" id="page-title">${t(title)}</h1><p class="subtitle">${t(description)}</p></div>`;
  }

  function componentsPage() {
    const cards = [['both', 'layers', 'both', 'bothDescription'], ['server', 'server', 'serverOnly', 'serverDescription'], ['client', 'computer', 'clientOnly', 'clientDescription']];
    return heading('componentsTitle', 'componentsDescription') + `<div class="component-grid" role="radiogroup" aria-label="${t('components')}">${cards.map(([value, symbol, title, description]) => `<label class="choice component"><input type="radio" name="components" value="${value}" ${options.components === value ? 'checked' : ''}><span class="choice-icon">${icon(symbol)}</span><span class="choice-title">${t(title)}</span><span class="choice-description">${t(description)}</span>${value === 'both' ? `<span class="recommendation">${t('recommended')}</span>` : ''}</label>`).join('')}</div>` + note(t('componentNote'));
  }

  function locationsPage() {
    return heading('locationsTitle', 'locationsDescription') + `<div class="panel">${[['velronHome', 'dataDirectory', 'dataHint'], ['commandDir', 'commandDirectory', 'commandHint']].map(([name, label, hint]) => `<div class="field"><label class="field-label" for="${name}">${t(label)}</label><div class="input-row"><input class="input" id="${name}" name="${name}" value="${escape(options[name])}" autocomplete="off" spellcheck="false"><button type="button" class="button small" data-browse="${name}" aria-label="${t(label)} ${t('browse')}">${icon('folder')}${t('browse')}</button></div><p class="field-hint">${t(hint)}</p></div>`).join('')}</div>` + note(t('pathNote'));
  }

  function serverPage() {
    const keep = config.exists && options.keepConfig;
    const existing = config.exists ? `<div class="panel">${toggle('keepConfig', 'keepConfig', 'keepHint')}${!config.valid && options.keepConfig ? `<p class="field-hint">${t('unreadableConfig')}</p>` : ''}</div>` : '';
    return heading('serverTitle', 'serverSubtitle') + existing + `<div class="panel">${field('serverHost', 'bindHost', 'bindHint', 'text', '', keep)}<div class="two-columns">${field('httpPort', 'httpPort', '', 'number', '', keep)}${field('vcpPort', 'vcpPort', '', 'number', '', keep)}</div>${field('allowedHosts', 'allowedHosts', 'hostsHint', 'text', 'velron.example.com, 192.168.1.10', keep)}</div><div class="panel">${toggle('autostart', 'autostart', 'autostartHint')}${toggle('startNow', 'startNow', 'startNowHint')}</div>`;
  }

  function clientPage() {
    const remote = options.connection === 'remote';
    return heading('clientTitle', 'clientSubtitle') + `<p class="section-title">${t('connectionLabel')}</p><div class="connection-grid" role="radiogroup" aria-label="${t('connectionLabel')}">${[['local', 'computer', 'localConnection', 'localDescription'], ['remote', 'globe', 'remoteConnection', 'remoteDescription']].map(([value, symbol, title, description]) => `<label class="choice connection">${icon(symbol)}<span><span class="choice-title">${t(title)}</span><span class="choice-description">${t(description)}</span></span><input type="radio" name="connection" value="${value}" ${options.connection === value ? 'checked' : ''}></label>`).join('')}</div>${remote ? `<div class="panel remote-fields">${field('vcpUrl', 'vcpUrl', 'vcpUrlHint', 'url', 'wss://server.example.com:4141/vcp/v1')}<div class="field"><label for="vcpToken" class="field-label">${t('token')}</label><div class="input-row"><input id="vcpToken" name="vcpToken" class="input" type="password" value="${escape(options.vcpToken)}" autocomplete="off" spellcheck="false" maxlength="43"><button type="button" class="button small" data-action="token" aria-controls="vcpToken" aria-pressed="false">${t('show')}</button></div><p class="field-hint">${t('tokenHint')}</p></div></div>` : ''}<div class="panel"><label class="field"><span class="field-label">${t('integration')}</span><select class="input" name="integration">${[['codex', 'Codex'], ['claude', 'Claude Code'], ['both', t('bothHosts')], ['other', t('otherHost')]].map(([value, label]) => `<option value="${value}" ${options.integration === value ? 'selected' : ''}>${label}</option>`).join('')}</select><span class="field-hint">${t('integrationHint')}</span></label></div>` + note(t('workspaceHint'));
  }

  function reviewPage() {
    const row = (label, value) => `<div class="summary-row"><span class="summary-label">${t(label)}</span><span class="summary-value">${escape(value)}</span></div>`;
    const section = (name, symbol, rows) => `<section class="review-section"><header><h2>${icon(symbol)}${t(name)}</h2><button type="button" class="text-button" data-step="${name}">${t('edit')}</button></header>${rows}</section>`;
    const componentName = { both: t('both'), server: t('serverOnly'), client: t('clientOnly') }[options.components];
    let sections = section('components', 'layers', row('components', componentName));
    sections += section('locations', 'folder', row('dataDirectory', options.velronHome) + row('commandDirectory', options.commandDir));
    if (hasServer()) sections += section('server', 'server', row('server', config.exists && options.keepConfig ? t('kept') : t('newConfig')) + row('bindHost', options.serverHost) + row('httpPort', options.httpPort) + row('vcpPort', options.vcpPort) + row('autostart', t(options.autostart ? 'yes' : 'no')) + row('startNow', t(options.startNow ? 'yes' : 'no')));
    if (hasClient()) sections += section('client', 'link', row('connectionLabel', options.connection === 'local' ? t('localDescription') : options.vcpUrl) + row('integration', { codex: 'Codex', claude: 'Claude Code', both: t('bothHosts'), other: t('otherHost') }[options.integration]));
    return heading('reviewTitle', 'reviewDescription') + `<div class="panel review-panel">${sections}</div>` + note(t('reviewNote'), true);
  }

  function logsPanel(open = false) {
    return `<details class="log-panel" ${open || logOpen ? 'open' : ''}><summary>${t('logs')}</summary><div class="log-toolbar"><button type="button" class="text-button" data-action="copy">${t('copyLogs')}</button></div><pre class="log-output" tabindex="0">${escape(logs.join('\n'))}</pre></details>`;
  }

  function progressPage() {
    const index = activeStage === 'complete' ? phases().length : phases().indexOf(activeStage);
    return heading('installingTitle', 'installingDescription') + `<div class="panel"><ol class="progress-list" aria-label="${t('setup')}">${phases().map((phase, i) => `<li class="${i < index ? 'finished' : i === index ? 'active' : ''}"><span class="progress-dot">${i < index ? icon('check') : ''}</span>${phaseTitle(phase)}</li>`).join('')}</ol><span class="sr-only" role="status">${phaseTitle(activeStage)}</span></div>` + logsPanel();
  }

  function resultPage() {
    if (result.status !== 'success') return heading(result.status === 'cancelled' ? 'cancelledTitle' : 'failedTitle', result.status === 'cancelled' ? 'cancelledDescription' : 'failedDescription', 'warning') + logsPanel(true);
    const warnings = result.warnings || [];
    return heading('successTitle', 'successDescription', 'check') + (warnings.length ? `<div class="panel warning"><h2>${t('warningsTitle')}</h2><p>${t('warningsHint')}</p><ul>${warnings.map(warning => `<li>${escape(warning.replace(/^! /, ''))}</li>`).join('')}</ul></div>` : '') + (hasClient() ? note(t('restartHint'), true) : '') + (hasServer() && !options.startNow ? note(t('manualStartHint')) : '') + `<div class="result-actions">${hasServer() && options.startNow ? button('open', t('openServer'), true, 'arrow') : ''}${hasClient() ? button('config', t('showConfig'), false, 'folder') : ''}</div>` + logsPanel(warnings.length > 0);
  }

  function render(focus = false) {
    if (!options) return;
    document.documentElement.lang = language;
    const currentIndex = steps().indexOf(step);
    const page = status === 'installing' ? progressPage() : status === 'result' ? resultPage() : ({ components: componentsPage, locations: locationsPage, server: serverPage, client: clientPage, review: reviewPage }[step])();
    const platform = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[environment.platform] || environment.platform;
    root.innerHTML = `<div class="shell${environment.platform === 'darwin' ? ' is-mac' : ''}"><header class="topbar"><div class="brand"><img src="assets/velron.svg" alt=""><span class="wordmark">Velron</span><span class="brand-divider"></span><span class="app-label">Installer</span></div><label class="language">${icon('globe')}<span class="sr-only">Language</span><select id="language"><option value="ko" ${language === 'ko' ? 'selected' : ''}>한국어</option><option value="en" ${language === 'en' ? 'selected' : ''}>English</option></select></label></header><aside class="sidebar"><p class="sidebar-label">${t('setup')}</p><nav aria-label="${t('setup')}"><ol class="steps">${steps().map((name, i) => `<li><button class="step-button${i < currentIndex || status !== 'setup' ? ' done' : ''}" type="button" data-step="${name}" ${status === 'setup' && name === step ? 'aria-current="step"' : ''} ${status !== 'setup' || i > currentIndex || busy ? 'disabled' : ''}><span class="step-number">${i < currentIndex || status !== 'setup' ? icon('check') : i + 1}</span>${t(name)}</button></li>`).join('')}</ol></nav><div class="sidebar-bottom"><p class="platform-label">${t('platform')}</p><div class="platform">${icon('computer')}<span>${escape(platform)} · ${escape(environment.arch === 'arm64' ? 'ARM64' : 'x64')}</span></div><p class="sidebar-tagline">${t('local')}</p></div></aside><main class="main"><div class="content">${errorText ? `<div class="error-box" role="alert">${escape(errorText)}</div>` : ''}<form id="wizard" novalidate>${page}</form></div><footer class="footer"><span class="footer-meta">${icon('shield')}CodenameMC <span>·</span> v${escape(environment.version)}</span>${status === 'setup' ? `${currentIndex ? button('back', t('back')) : ''}${button(step === 'review' ? 'install' : 'next', t(step === 'review' ? 'install' : 'next'), true, 'arrow')}` : status === 'installing' ? button('cancel', t('cancel')) : `${result.status !== 'success' ? button('retry', t('retry'), true) : ''}${button('close', t('close'))}`}</footer></main></div>`;
    root.removeAttribute('aria-busy');
    if (busy) root.querySelectorAll('#wizard input, #wizard select, #wizard button').forEach(control => { control.disabled = true; });
    root.querySelector('details')?.addEventListener('toggle', event => { logOpen = event.target.open; });
    root.querySelector('#wizard').addEventListener('submit', event => { event.preventDefault(); if (status === 'setup') action(step === 'review' ? 'install' : 'next'); });
    if (focus) root.querySelector('#page-title')?.focus({ preventScroll: true });
  }

  function saveForm() {
    for (const input of root.querySelectorAll('[name]')) {
      if (input.type === 'radio') { if (input.checked) options[input.name] = input.value; }
      else if (input.type === 'checkbox') options[input.name] = input.checked;
      else options[input.name] = input.type === 'number' ? Number(input.value) : input.value;
    }
  }

  function validateStep() {
    if (step === 'locations') {
      const absolute = environment.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/ : /^\//;
      if (![options.velronHome, options.commandDir].every(value => absolute.test(value) && !/[\x00-\x1f]/.test(value))) throw new Error(t('pathError'));
    }
    if (step === 'server') {
      if (config.exists && options.keepConfig && !config.valid) throw new Error(t('unreadableConfig'));
      if (![options.httpPort, options.vcpPort].every(value => Number.isInteger(value) && value > 0 && value < 65536) || options.httpPort === options.vcpPort) throw new Error(t('portError'));
      if (!/^[A-Za-z0-9.:[\]_-]+$/.test(options.serverHost) || options.allowedHosts.split(',').some(value => value.trim() && !/^[A-Za-z0-9.:[\]_-]+$/.test(value.trim()))) throw new Error(t('hostError'));
    }
    if (step === 'client' && options.connection === 'remote') {
      let url;
      try { url = new URL(options.vcpUrl); } catch { throw new Error(t('urlError')); }
      if (url.protocol !== 'wss:' || !url.hostname || url.pathname !== '/vcp/v1' || url.username || url.password || /[?#]/.test(options.vcpUrl)) throw new Error(t('urlError'));
      if (!/^[A-Za-z0-9_-]{43}$/.test(options.vcpToken)) throw new Error(t('tokenError'));
    }
  }

  async function action(name) {
    if (busy) return;
    try {
      if (status === 'setup') saveForm();
      errorText = '';
      if (name === 'next') {
        validateStep();
        if (step === 'locations' && hasServer()) {
          busy = true; render();
          config = await api.inspectConfig(options.velronHome);
          if (config.exists && config.valid && options.keepConfig) Object.assign(options, { httpPort: config.httpPort, vcpPort: config.vcpPort, serverHost: config.serverHost });
          busy = false;
        }
        step = steps()[steps().indexOf(step) + 1];
        render(true);
      } else if (name === 'back') { step = steps()[steps().indexOf(step) - 1]; render(true); }
      else if (name === 'install') {
        status = 'installing'; activeStage = 'download'; logs = []; result = null; render(true);
        result = await api.install({ ...options });
        status = 'result';
        if (result.status === 'success') options.vcpToken = '';
        render(true);
      } else if (name === 'retry') { status = 'setup'; step = 'review'; render(true); }
      else if (name === 'cancel') await api.cancel();
      else if (name === 'close') await api.close();
      else if (name === 'open') await api.openServer();
      else if (name === 'config') await api.showConfig();
      else if (name === 'copy') {
        await api.copyLogs();
        root.querySelector('[data-action="copy"]').textContent = t('copied');
      } else if (name === 'token') {
        const input = root.querySelector('#vcpToken');
        const show = input.type === 'password'; input.type = show ? 'text' : 'password';
        const control = root.querySelector('[data-action="token"]');
        control.textContent = t(show ? 'hide' : 'show'); control.setAttribute('aria-pressed', String(show));
      }
    } catch (error) {
      busy = false;
      if (status === 'installing') { result = { status: 'failed', warnings: [] }; status = 'result'; }
      errorText = error.message; render();
    }
  }

  root.addEventListener('change', event => {
    if (event.target.id === 'language') { if (status === 'setup') saveForm(); language = event.target.value; render(); }
    else if (status === 'setup') {
      saveForm();
      if (['components', 'connection', 'keepConfig'].includes(event.target.name)) {
        if (event.target.name === 'keepConfig' && options.keepConfig && config.valid && config.exists) Object.assign(options, { httpPort: config.httpPort, vcpPort: config.vcpPort, serverHost: config.serverHost });
        render();
      }
    }
  });
  root.addEventListener('click', async event => {
    const control = event.target.closest('button');
    if (!control || control.disabled) return;
    if (control.dataset.action) action(control.dataset.action);
    else if (control.dataset.step && status === 'setup') { saveForm(); step = control.dataset.step; errorText = ''; render(true); }
    else if (control.dataset.browse) {
      saveForm();
      try { const selected = await api.chooseDirectory(options[control.dataset.browse]); if (selected) { options[control.dataset.browse] = selected; render(); } }
      catch (error) { errorText = error.message; render(); }
    }
  });

  async function start() {
    try {
      environment = await api.getDefaults(); options = environment.options;
      language = environment.locale.startsWith('ko') ? 'ko' : 'en';
      api.onProgress(event => {
        if (event.type === 'log') {
          logs.push(event.line); if (logs.length > 600) logs.shift();
          const output = root.querySelector('.log-output');
          if (output) { const bottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40; output.textContent = logs.join('\n'); if (bottom) output.scrollTop = output.scrollHeight; }
        } else if (event.type === 'stage') { activeStage = event.stage; if (status === 'installing') render(); }
      });
      render();
    } catch {
      root.textContent = t('unavailable'); root.className = 'loading'; root.removeAttribute('aria-busy');
    }
  }
  start();
})();
