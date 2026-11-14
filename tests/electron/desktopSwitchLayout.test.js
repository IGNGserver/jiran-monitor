'use strict';

// The Fluent switch owns the thumb position inside its shadow tree. A host-level
// ::part override that guesses at the checked attribute can pin every state to
// the middle/left, so keep the renderer stylesheet from taking over that logic.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const appCss = fs.readFileSync(path.join(root, 'src', 'shared-ui', 'styles', 'app.css'), 'utf8');
const desktopCss = fs.readFileSync(path.join(root, 'src', 'electron', 'renderer', 'desktop.css'), 'utf8');

test('desktop CSS does not override Fluent switch thumb positioning', () => {
  assert.doesNotMatch(appCss, /fluent-switch::part\(checked-indicator\)/);
  assert.doesNotMatch(appCss, /fluent-switch\[aria-checked=/);
  assert.match(appCss, /fluent-switch\s*\{\s*display:\s*inline-flex/);
  assert.match(desktopCss, /desktop-setting-switch-row > fluent-switch/);

  const switchRule = desktopCss.match(/\.desktop-setting-switch-row > fluent-switch\s*\{([^}]*)\}/);
  assert.ok(switchRule, 'desktop.css must define .desktop-setting-switch-row > fluent-switch');
  assert.doesNotMatch(switchRule[1], /\bjustify-content\s*:/,
    'justify-content on fluent-switch host centers the shadow thumb in the track');

  const sharedSwitchRule = appCss.match(/\bfluent-switch\s*\{([^}]*)\}/);
  assert.ok(sharedSwitchRule);
  assert.doesNotMatch(sharedSwitchRule[1], /\bjustify-content\s*:/);
});

test('shared UI styles keep mode toggles, spinners, and full-width text inputs functional', () => {
  assert.match(appCss, /\.mode-toggle\.selected/);
  assert.match(appCss, /\.mode-toggle:has\(fluent-radio:state\(checked\)\)/);
  assert.match(appCss, /fluent-text-input\.field\s*\{[^}]*max-width:\s*none/);
  assert.doesNotMatch(appCss, /fluent-spinner\s*\{[^}]*visibility:\s*hidden/,
    'reduced motion must freeze spinner animation rather than hiding the indicator');
  assert.match(appCss, /html\[data-motion="reduce"\] fluent-spinner\s*\{[^}]*--duration:\s*0s/);
});
