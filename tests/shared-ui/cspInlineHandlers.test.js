'use strict';

// The Hub and the desktop both serve the shared UI under a `script-src 'self'`
// CSP, which blocks inline event-handler attributes outright. An `onerror=` (or
// any other `on*=`) in a template therefore does nothing at all: it is dead code
// that looks like a fallback. These assertions keep the templates honest instead
// of relying on a review to notice.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const INLINE_HANDLER = /\son(?:error|load|click|change|input|submit|focus|blur|keydown|keyup|keypress|mouseover|mouseout|mousedown|mouseup|pointerdown|pointerup|toggle)="/g;

test('shared UI templates do not rely on CSP-blocked inline event handlers', () => {
  const targets = [
    ...walk(path.join(root, 'src', 'shared-ui')),
    ...walk(path.join(root, 'src', 'hub', 'web')),
    ...walk(path.join(root, 'src', 'electron', 'renderer'))
  ];
  assert.ok(targets.length > 10, 'expected the shared UI template tree');
  const offenders = [];
  for (const file of targets) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(INLINE_HANDLER)) {
      const line = text.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative(root, file)}:${line}${match[0].trimEnd()}`);
    }
  }
  assert.deepEqual(offenders, [], `inline handlers never run under script-src 'self':\n${offenders.join('\n')}`);
});

test('a failed client icon is hidden by a delegated capture-phase listener', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'shared-ui', 'app.js'), 'utf8');
  // `error` does not bubble, so the handler has to be registered in the capture
  // phase on the container that is rebuilt on every render.
  assert.match(
    app,
    /els\.content\.addEventListener\('error',\s*\(event\)\s*=>\s*\{[\s\S]{0,400}?classList\.contains\('client-icon'\)[\s\S]{0,200}?classList\.add\('hidden'\)/,
    'the shared app must hide a broken .client-icon from a capture-phase error listener'
  );
  assert.match(app, /\},\s*true\);/);
});
