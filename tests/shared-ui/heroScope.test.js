'use strict';

// The hero card follows the scope tab, so the card itself has to name the window
// its figure belongs to.
//
// The tab bar is not enough. It is one small pill in the toolbar, the selected
// period persists in the browser's localStorage, and the card used to be labelled
// only `stats.tokens`. A 累计 total therefore sat under a label that named no
// window at all, and the reader supplied "today" — which is how an all-time figure
// became a bug report saying the product counted 上百亿 tokens today.
//
// These are source guards rather than rendering tests because both hosts render the
// same shared UI from static HTML that Node cannot execute.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const HOSTS = [
  path.join(ROOT, 'src', 'hub', 'web', 'index.html'),
  path.join(ROOT, 'src', 'electron', 'renderer', 'index.html')
].map((file) => ({ name: path.relative(ROOT, file), file }));

const appSource = fs.readFileSync(path.join(ROOT, 'src', 'shared-ui', 'app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(ROOT, 'src', 'shared-ui', 'styles', 'app.css'), 'utf8');

const PERIOD_SCOPED_CARDS = ['totalTokens', 'totalCost'];
// Devices and Live describe the fleet, not a window: a period label there is a lie.
const PERIOD_FREE_CARDS = ['deviceCount', 'liveLabel'];

function heroCard(html, valueId) {
  const at = html.indexOf(`id="${valueId}"`);
  assert.ok(at >= 0, `${valueId} must exist in the hero strip`);
  const start = html.lastIndexOf('<div class="hero-card">', at);
  assert.ok(start >= 0, `${valueId} must sit inside a hero card`);
  return html.slice(start, html.indexOf('</div>', at));
}

/** The body of a top-level `function name() { ... }` in app.js. */
function functionBody(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() must exist in shared-ui/app.js`);
  const end = appSource.indexOf('\n}', start);
  assert.ok(end > start, `${name}() must have a body`);
  return appSource.slice(start, end);
}

test('period-scoped hero cards name their window, and period-free cards do not', () => {
  for (const { name, file } of HOSTS) {
    const html = fs.readFileSync(file, 'utf8');
    for (const valueId of PERIOD_SCOPED_CARDS) {
      assert.match(
        heroCard(html, valueId),
        /data-hero-scope/,
        `${name}: the ${valueId} card renders a period-scoped figure, so it must carry a scope label`
      );
    }
    for (const valueId of PERIOD_FREE_CARDS) {
      assert.doesNotMatch(
        heroCard(html, valueId),
        /data-hero-scope/,
        `${name}: the ${valueId} card is not period-scoped and must not claim a window`
      );
    }
  }
});

test('renderHero writes the scope label from the same key the tab bar highlights', () => {
  const body = functionBody('renderHero');
  assert.match(body, /els\.heroScopes/, 'renderHero is the only writer of the scope labels');
  assert.ok(
    body.includes('tr(`period.${selectedScopeKey()}`)'),
    'the label must come from selectedScopeKey(), not from a second reading of prefs.period'
  );

  // The tab bar has to read the same key, or the highlight and the label can disagree.
  assert.ok(
    appSource.includes('const selectedPeriod = selectedScopeKey();'),
    'the tab bar must resolve its selection through selectedScopeKey()'
  );

  const helper = functionBody('selectedScopeKey');
  assert.match(helper, /customRange\?\.kind === 'custom'/, 'a hand-picked range keeps its own chip');
  assert.match(helper, /state\.prefs\.period/, 'every other scope comes from the persisted period');
});

test('the page meta always states the period, not only when one device is selected', () => {
  const at = appSource.indexOf('const scopeMeta = ');
  assert.ok(at >= 0, 'renderChrome must build scopeMeta');
  const line = appSource.slice(at, appSource.indexOf('\n', at));
  assert.match(line, /\[periodLabel,/, 'periodLabel must be unconditional: all devices is the default view');
  assert.doesNotMatch(line, /scoped\s*\?/, 'the period name must not be gated on a device filter');
});

test('the scope label is written by renderHero, not by applyI18n', () => {
  for (const { name, file } of HOSTS) {
    const html = fs.readFileSync(file, 'utf8');
    // applyI18n() rewrites textContent of every [data-i18n] element on each locale
    // change, so a data-i18n scope node would silently drop the period again.
    assert.doesNotMatch(
      html,
      /<span[^>]*data-hero-scope[^>]*data-i18n|<span[^>]*data-i18n[^>]*data-hero-scope/,
      `${name}: the scope label must not carry data-i18n`
    );
  }
  assert.match(cssSource, /\.hero-scope\s*\{/, 'the scope label needs a rule that resets the label casing');
});

// The footnote exists because the headline is not what a reader assumes: a cache
// re-read counts as a token, and 累计 additionally keeps archived sessions. Both
// facts have to stay on the card, or the figure becomes unexplainable again.
test('the hero footnote discloses cache re-reads and the archived share', () => {
  for (const { name, file } of HOSTS) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(heroCard(html, 'totalTokens'), /data-hero-note/, `${name}: the Tokens card must carry the footnote`);
    // The footnote explains the token figure only; borrowing it for cost, devices or
    // liveness would assert a provenance those cards do not have.
    for (const valueId of ['totalCost', ...PERIOD_FREE_CARDS]) {
      assert.doesNotMatch(heroCard(html, valueId), /data-hero-note/, `${name}: ${valueId} must not borrow the token footnote`);
    }
  }

  const body = functionBody('renderHero');
  assert.match(body, /stats\.cacheReadShare/, 'the cache re-read share is the other half of the explanation');
  assert.match(body, /stats\.archived/, 'the archived share names what cannot be proven from disk');
  assert.match(body, /els\.heroNotes/, 'renderHero is the only writer of the footnote');
  assert.match(cssSource, /\.hero-note\s*\{/, 'the footnote needs its own rule so it reads as a footnote');
});

test('every key the hero writes exists in the catalog', () => {
  // `t()` falls back to the key itself, so a typo renders as "stats.cacheReadShare"
  // on screen and no other test notices.
  const body = functionBody('renderHero');
  const keys = new Set();
  for (const match of body.matchAll(/tr\(`?'?(stats\.[a-zA-Z.]+)'?/g)) keys.add(match[1]);
  assert.ok(keys.size >= 2, `expected the hero to translate its own labels, found ${[...keys].join(', ') || 'none'}`);

  const catalog = fs.readFileSync(path.join(ROOT, 'src', 'shared-ui', 'core', 'i18n.js'), 'utf8');
  for (const key of keys) {
    assert.ok(catalog.includes(`'${key}':`), `${key} is written by renderHero but missing from the catalog`);
  }
  // The scope label is built dynamically, so check the keys it can produce.
  for (const period of ['today', 'yesterday', 'week', 'month', 'allTime', 'custom']) {
    assert.ok(catalog.includes(`'period.${period}':`), `period.${period} is reachable from the hero scope label`);
  }
});
