const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { isInstallerPage } = require('../app/installerPage.cjs');

const actual = 'file:///C:/Users/TESTER~1/AppData/Local/Temp/installer/resources/app.asar/ui/index.html';
const expected = actual.replace('~', '%7E');
const windows = { windows: true };

test('Windows short-path tilde encoding does not reject the Installer page', () => {
  assert.notEqual(actual, expected);
  assert.equal(isInstallerPage(actual, expected, windows), true);
  assert.equal(isInstallerPage(expected, actual, windows), true);
  assert.equal(isInstallerPage(actual.replace('~', '%7e'), expected, windows), true);
});

test('Unicode, spaces, percent signs and hash characters are decoded exactly once', () => {
  const expectedUrl = pathToFileURL('C:\\Users\\테스터~1\\100% # files\\index.html', windows).href;
  assert.equal(isInstallerPage(expectedUrl.replace(/%7E/gi, '~'), expectedUrl, windows), true);
  assert.equal(isInstallerPage(actual.replace('~', '%257E'), expected, windows), false);
  const posixUrl = 'file:///tmp/Tester%7E1/Velron%20Installer/index.html';
  assert.equal(isInstallerPage(posixUrl.replace('%7E', '~'), posixUrl, { windows: false }), true);
});

test('different files, remote pages, URL suffixes and invalid encodings remain rejected', () => {
  for (const url of [
    actual.replace('index.html', 'other.html'),
    actual.replace('app.asar/', 'other.asar/'),
    actual.replace('C:/', 'D:/'),
    actual.replace('file:///', 'https://example.com/'),
    actual.replace('file:///', 'file://other-host/'),
    actual + '?debug=1', actual + '#frame', actual + '?', actual + '#',
    actual.replace('/ui/', '%2Fui/'), actual.replace('/ui/', '%5Cui/'),
    actual.replace('~', '%'), actual.replace('~', '%FF'),
    'about:blank', 'javascript:void(0)', '', null, undefined,
  ]) assert.equal(isInstallerPage(url, expected, windows), false, String(url));
});
