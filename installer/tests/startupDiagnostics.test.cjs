const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStartupDiagnostics } = require('../app/startupDiagnostics.cjs');

test('startup failures retain stage, stack and runtime details on disk without tokens', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velron-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnostics = createStartupDiagnostics({ directory, version: '2.0.0' });
  const token = 'a'.repeat(43);
  const report = diagnostics.record('preload', new Error(`Cannot load module; token=${token}`));
  assert.match(report, /preload/);
  assert.match(report, /startupDiagnostics.test.cjs/);
  assert.match(report, /Velron Installer 2.0.0/);
  assert.match(report, /Node:/);
  assert.doesNotMatch(report, new RegExp(token));
  assert.equal(fs.readFileSync(diagnostics.file, 'utf8'), report);
});

test('unwritable log directory preserves a readable error report and bounded history', () => {
  const io = { mkdirSync() { throw new Error('EACCES: permission denied'); } };
  const diagnostics = createStartupDiagnostics({ directory: '/unwritable', version: '2.0.0', io });
  for (let i = 0; i < 30; i++) diagnostics.record(`stage-${i}`, 'x'.repeat(20000));
  const report = diagnostics.report();
  assert.match(report, /Log write failed: EACCES/);
  assert.match(report, /stage-29/);
  assert.doesNotMatch(report, /stage-0\n/);
  assert.ok(report.length < 250000);
});
