'use strict';

// Window materials are drawn by the OS under the web contents, so a CSS
// backdrop-filter on a persistent surface usually blurs nothing visible but
// costs a render surface and a blur pass per element per frame. Transient
// overlays (drawers, popovers) sit over page content and may blur; the three
// persistent blurs below were measured to change pixels (they sit over another
// translucent layer) and are kept on purpose. Adding a persistent blur means
// showing it is visible first.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'desktop.css'), 'utf8');

const VISIBLE_PERSISTENT_BLURS = Object.freeze([
  'body[data-window-surface="transparent"] .sidebar',
  'body[data-window-surface="vibrancy"] .desktop-sync-status',
  'body[data-window-surface="liquid-glass"] .desktop-sync-status'
]);

function rules(text) {
  const out = [];
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(stripped)) !== null) out.push({ selector: match[1].trim(), body: match[2] });
  return out;
}

test('material modes blur only transient overlays', () => {
  const blurring = rules(css).filter((rule) => /backdrop-filter\s*:(?!\s*none)/.test(rule.body));
  assert.ok(blurring.length > 0, 'the overlay blur is still present');
  for (const rule of blurring) {
    const selectors = rule.selector.split(/,(?![^(]*\))/).map((part) => part.trim());
    for (const selector of selectors) {
      if (VISIBLE_PERSISTENT_BLURS.includes(selector)) continue;
      assert.match(selector, /\.(drawer-panel|popover-card)$/, `persistent surface must not blur: ${selector}`);
    }
  }
});

test('the blurs that are visible are still there', () => {
  for (const selector of VISIBLE_PERSISTENT_BLURS) {
    const rule = rules(css).find((entry) => entry.selector === selector);
    assert.ok(rule, `${selector} exists`);
    assert.match(rule.body, /backdrop-filter:\s*blur\(/, `${selector} keeps its blur`);
  }
});

test('every material mode still tints its persistent surfaces', () => {
  for (const surface of ['mica', 'acrylic', 'transparent', 'vibrancy', 'liquid-glass']) {
    for (const part of ['.sidebar', '.panel', '.hero', '.scope-commandbar']) {
      const rule = rules(css).find((entry) => entry.selector === `body[data-window-surface="${surface}"] ${part}`);
      assert.ok(rule, `${surface} ${part} rule exists`);
      assert.match(rule.body, /background:\s*color-mix/, `${surface} ${part} keeps its translucent tint`);
    }
  }
});
