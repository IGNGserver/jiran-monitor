'use strict';

// A data refresh must not interrupt an action in progress.
//
// A stats frame arrives every few seconds (SSE on the Hub, the local collector's
// tick on the desktop) and used to rebuild `#content` wholesale. That closes an
// open Fluent dropdown, snaps a half-typed value back, moves an expanded row and
// drops focus — the user's own action, undone by a background update. These tests
// pin the four mechanisms that stop it:
//
//   1. a quiet (data-driven) render is deferred while a transient control is open;
//   2. a quiet render that produces identical HTML does not touch the DOM at all;
//   3. the render snapshot restores open menus, focus and nested scroll regions;
//   4. the chrome subtrees and the animation layer are only rewritten on a change.
//
// The behaviour that depends on a real DOM is asserted by reading the source; the
// skip-write / deferral logic is exercised in a `vm` with a stub element.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', '..', 'src', 'shared-ui', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');

/** The render/deferral slice of app.js, evaluated against a stub host. */
function loadRender({ popoverOpen = false, block = false, hidden = false, view = 'overview' } = {}) {
  const source = appSource.slice(
    appSource.indexOf('const DEFERRED_RENDER_EVENTS'),
    appSource.indexOf('async function ensureHistory')
  );
  let onVisibility;
  let writes = 0;
  let html = '';
  // `popoverOpen` is read through a mutable ref so a test can close the popover
  // mid-scenario, which is what makes the deferred frame replay.
  const ui = { popoverOpen, block };
  const content = {
    set innerHTML(value) { writes++; html = value; },
    get innerHTML() { return html; },
    querySelector(selector) {
      if (selector === 'fluent-dropdown fluent-listbox:popover-open') return ui.popoverOpen ? {} : null;
      if (selector === '.management-drawer:not(.hidden)') return ui.block ? {} : null;
      return null;
    }
  };
  const context = {
    document: {
      hidden,
      activeElement: null,
      addEventListener: (_, callback) => { onVisibility = callback; }
    },
    els: { content },
    state: { prefs: { view }, stats: { value: 0 }, formDrafts: new Map() },
    captureRenderState: () => ({}),
    restoreRenderState() {},
    isCapable: () => false,
    renderChrome() {},
    renderHero() {},
    renderDesktopSyncStatus() {},
    escapeHtml: (value) => String(value ?? ''),
    tr: (key) => key,
    renderHome: () => String(context.state.stats.value)
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    context,
    stats: (value) => { context.state.stats.value = value; },
    closePopover: () => { ui.popoverOpen = false; },
    // `let` bindings are not properties of a `vm` context global, so read them by
    // evaluating an expression in the same context.
    renderPending: () => vm.runInContext('renderPending', context),
    writes: () => writes,
    html: () => html,
    fireVisibility: () => onVisibility()
  };
}

test('a quiet render is deferred while a dropdown popover is open, then replayed', () => {
  const handle = loadRender({ popoverOpen: true });
  handle.stats(1);
  handle.context.render({ quiet: true });
  assert.equal(handle.writes(), 0, 'an open dropdown must not be torn down by a data frame');
  assert.equal(handle.renderPending(), true, 'the frame is held, not dropped');

  // The user picks an option; the popover closes and the pending frame paints.
  handle.closePopover();
  handle.context.renderDeferred();
  assert.equal(handle.writes(), 1);
  assert.equal(handle.html(), '1');
  assert.equal(handle.renderPending(), false);
});

test('a user-driven render is never deferred by an open control', () => {
  // The click that opened the popover also triggers a render; deferring it would
  // leave the just-opened control unrendered. Only data frames may defer.
  const handle = loadRender({ popoverOpen: true });
  handle.stats(2);
  handle.context.render();
  assert.equal(handle.writes(), 1, 'an explicit render commits even with a control open');
});

test('a decision to defer survives until the interaction actually ends', () => {
  const handle = loadRender({ popoverOpen: true });
  handle.stats(3);
  handle.context.render({ quiet: true });
  assert.equal(handle.writes(), 0);

  // The retry still sees the popover open, so it must not force the write.
  handle.context.renderDeferred();
  assert.equal(handle.writes(), 0, 'the replay is itself quiet');

  // A user action (here: an explicit render) commits.
  handle.context.render();
  assert.equal(handle.writes(), 1);
  assert.equal(handle.renderPending(), false);
});

test('a quiet render that changes nothing leaves the DOM untouched', () => {
  const handle = loadRender();
  handle.stats(7);
  handle.context.render({ quiet: true });
  assert.equal(handle.writes(), 1, 'the first paint writes');
  handle.context.render({ quiet: true });
  handle.context.render({ quiet: true });
  assert.equal(handle.writes(), 1, 'identical bytes cost no DOM write');
  assert.equal(handle.html(), '7');

  handle.stats(8);
  handle.context.render({ quiet: true });
  assert.equal(handle.writes(), 2, 'a real change still paints');
});

test('a hidden tab coalesces frames and paints once on return', () => {
  const handle = loadRender({ hidden: true });
  for (let index = 1; index <= 50; index += 1) {
    handle.stats(index);
    handle.context.render({ quiet: true });
  }
  assert.equal(handle.writes(), 0, 'a hidden tab does no DOM work');
  handle.context.document.hidden = false;
  handle.fireVisibility();
  assert.equal(handle.writes(), 1);
  assert.equal(handle.html(), '50', 'only the newest state is painted');
});

// ─── Source-level contracts ─────────────────────────────────────────────────
//
// These are properties of a DOM interaction that a vm cannot exercise: they
// assert the mechanism exists, next to the code that owns it.

test('the render snapshot restores open dropdowns, stable identities and nested scroll', () => {
  assert.match(appSource, /function describeFormControl\(/, 'form controls are described by value, not index alone');
  assert.match(appSource, /const IDENTITY_ATTRIBUTES = \[/, 'a stable identity attribute list exists');
  assert.match(appSource, /'data-management-focus'/, 'the menu identity attribute is included');
  assert.match(appSource, /data-select-tool/, 'tool selections are restored by identity');
  assert.match(appSource, /openDropdowns: openDropdowns\.map/, 'open dropdowns are captured');
  assert.match(appSource, /listbox\.showPopover\(\)/, 'an open dropdown is reopened after the rebuild');
  assert.match(appSource, /function captureScrollRegions\(/, 'nested scroll regions are captured');
  assert.match(appSource, /function restoreScrollRegions\(/, 'nested scroll regions are restored');
  assert.match(appSource, /scrollRegions: captureScrollRegions\(\)/);
  // A class-only menu (the device action menu) is one per row, so restore must use
  // the recorded index instead of always reopening the first match.
  assert.match(appSource, /openDetails\.push\(\{ type: 'class', value: className, index: sameClass\.indexOf\(detail\) \}\)/);
  assert.match(appSource, /const sameClass = \[\.\.\.els\.content\.querySelectorAll\(`details\.\$\{entry\.value\.trim\(\)\.split\(\/\\s\+\/\)\.join\('\.'\)\}`\)\]/);
});

test('reopening a detail does not replay its entrance animation', () => {
  assert.match(appSource, /match\.dataset\.restoredOpen = '1'/, 'the restore marks the open as programmatic');
  assert.match(appSource, /if \(match && !match\.open\)/, 'an already-open detail is not reassigned');
  const fluent = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared-ui', 'core', 'fluent.js'), 'utf8');
  assert.match(fluent, /if \(event\.target\.dataset\.restoredOpen\)/, 'the toggle listener ignores a snapshot restore');
});

/** `writeHtmlIfChanged` from app.js, evaluated on its own. */
function loadWriteHtmlIfChanged() {
  const source = appSource.slice(
    appSource.indexOf('const writtenHtml = new WeakMap();'),
    appSource.indexOf('function renderStaticUiIcons()')
  );
  return vm.runInNewContext(`${source}; writeHtmlIfChanged;`, { WeakMap });
}

/** A container whose innerHTML reads back the way a browser serializes it. */
function serializingElement() {
  let html = '';
  let nodes = 0;
  const element = {
    writes: 0,
    get childNodes() { return { length: nodes }; },
    // An inline SVG `<path/>` serializes as `<path></path>` and `" >` as `">`:
    // the read-back never equals the template that produced it.
    get innerHTML() { return html.replace(/<path([^>]*?)\/>/g, '<path$1></path>').replace(/" >/g, '">'); },
    set innerHTML(value) { element.writes += 1; html = value; nodes = value ? 1 : 0; }
  };
  return element;
}

test('chrome subtrees are only rewritten when they actually change', () => {
  const writeHtmlIfChanged = loadWriteHtmlIfChanged();
  const nav = serializingElement();
  const template = '<a class="nav-btn " data-view="usage" ><span><svg><path d="M4 19V5"/></svg></span></a>';
  assert.notEqual(nav.innerHTML, template, 'the stub reproduces the serialization mismatch');
  assert.equal(writeHtmlIfChanged(nav, template), true);
  // The same frame again, many times: the subtree is left alone even though
  // reading innerHTML back would never match the template.
  for (let frame = 0; frame < 5; frame += 1) assert.equal(writeHtmlIfChanged(nav, template), false);
  assert.equal(nav.writes, 1);
  assert.equal(writeHtmlIfChanged(nav, template.replace('usage', 'devices')), true);
  assert.equal(nav.writes, 2);

  // Every chrome subtree goes through the helper rather than an innerHTML compare.
  assert.doesNotMatch(appSource, /\.innerHTML !== /, 'no guard compares against serialized innerHTML');
  assert.match(appSource, /writeHtmlIfChanged\(els\.primaryNav, navHtml\)/);
  assert.match(appSource, /writeHtmlIfChanged\(els\.periodTabs, periodTabsHtml\)/);
  assert.match(appSource, /writeHtmlIfChanged\(nav, navHtml\)/);
  assert.match(appSource, /optionsChanged = writeHtmlIfChanged\(deviceListbox, deviceOptionsHtml\)/);
});

test('a data update does not replay the entrance or chart sweep', () => {
  const fluent = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared-ui', 'core', 'fluent.js'), 'utf8');
  // `pendingDataUpdate` must no longer drive the entrance/panel sweep...
  assert.doesNotMatch(fluent, /else if \(pendingDataUpdate\) \{/);
  assert.match(fluent, /if \(changedView && !lastView\) \{/);
  // ...nor re-sweep a chart that was already animated for this view.
  assert.match(fluent, /const shouldAnimateChart = Boolean\(chartTargets\)\s*\n\s*&& \(changedView \|\| !animatedChartViews\.has\(view\)\);/);
});

test('the Android syncing indicator cannot change the header height', () => {
  // It is always composed (only alpha animates), so flipping `isRefreshing` between
  // frames cannot re-measure the header and push the list the user is reading.
  const overview = fs.readFileSync(path.join(
    __dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com', 'igng', 'tokenmonitor', 'android', 'ui', 'overview', 'OverviewScreen.kt'
  ), 'utf8');
  assert.match(overview, /targetValue = if \(state\.isRefreshing\) 1f else 0f/, 'visibility is animated, not toggled');
  assert.doesNotMatch(overview, /if \(state\.isRefreshing\) \{\s*\n\s*Row\(/, 'the row is not conditionally composed');
});

test('the device action menu carries a stable key so it reopens on the same row', () => {
  const devices = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared-ui', 'views', 'devices.js'), 'utf8');
  assert.match(devices, /data-management-focus="device-\$\{escapeHtml\(row\.key\)\}"/);
});

test('non-form settings groups participate in the draft mechanism', () => {
  const settings = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared-ui', 'views', 'settings.js'), 'utf8');
  const transfer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared-ui', 'views', 'transfer.js'), 'utf8');
  assert.match(settings, /data-desktop-settings data-draft-key="desktop-settings"/);
  assert.match(transfer, /data-transfer-form data-draft-key="transfer-device"/);
  // The snapshot/restore helpers operate on any `[data-draft-key]` scope, not just
  // a `<form>`, and understand Fluent's switch/radio-group controls.
  assert.match(appSource, /function draftScopes\(root = els\.content\) \{/);
  assert.match(appSource, /control\.matches\('fluent-switch, fluent-checkbox'\)/);
  assert.match(appSource, /control\.matches\('fluent-radio-group'\)/);
});

test('an Escape key does not close a page overlay under an open dropdown', () => {
  assert.match(appSource, /const openPopover = els\.content\.querySelector\('fluent-dropdown fluent-listbox:popover-open'\);\s*\n\s*if \(openPopover\) return;/);
});
