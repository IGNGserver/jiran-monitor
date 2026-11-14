'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

test('Electron login items target the current executable explicitly', () => {
  assert.match(main, /function electronLoginItemPath\(\)/);
  assert.match(main, /const executablePath = electronLoginItemPath\(\);/);
  assert.match(main, /\.\.\.\(executablePath \? \{ path: executablePath \} : \{\}\)/);
});

test('startup does not erase a requested autostart state on one failed read-back', () => {
  const start = main.indexOf('function syncLoginItemSettingFromOs()');
  const end = main.indexOf('\n}', start);
  const body = main.slice(start, end);
  assert.match(body, /settings\.startAtLogin === true && actual === false/);
  assert.match(body, /applyLoginItem\(true\)/);
  assert.match(body, /keeping the requested state/);
  assert.match(body, /macosAutostart\.readAutostartEntry/);
});

test('macOS login items use a LaunchAgent plist with --hidden instead of openAsHidden', () => {
  const applyStart = main.indexOf('function applyLoginItem(startAtLogin)');
  const applyEnd = main.indexOf('\n}', applyStart);
  const applyBody = main.slice(applyStart, applyEnd);
  assert.match(applyBody, /macosAutostart\.setAutostartEnabled/);
  assert.match(applyBody, /clearLegacyMacosLoginItem\(\)/);
  assert.doesNotMatch(applyBody, /openAsHidden/);
});
