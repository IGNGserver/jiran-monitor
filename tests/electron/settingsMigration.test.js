'use strict';

// Upgrade compatibility.
//
// The rewrite must not cost an existing install its configuration: the user
// asked for a lossless migration, and AGENTS.md treats settings keys as a
// compatibility surface. These tests pin both halves of that promise — retained
// keys survive, and widget-era keys are dropped rather than left behind looking
// like they still do something.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'src', 'electron', 'main.js'), 'utf8');

// Keys the desktop settings document still owns. Each must appear in
// defaultSettings(), and — unlike before this pass — every one of them has a
// writer: a settings form control, a shared-UI preference, the tray, an in-app
// gesture, or the main process itself. Keys whose only surface disappeared keep
// their behaviour as code constants instead (src/shared/collectorConfig.js).
const RETAINED_KEYS = [
  'hubMode', 'hubUrl', 'secret', 'allowInsecureHubHttp', 'deviceId',
  'theme', 'systemGlass', 'macosGlassStyle', 'windowsBackdrop', 'reduceMotion',
  'language', 'currency', 'currencyRates',
  'heatmapMetric', 'homeActiveDaysWindow', 'homeLimitAccountCount',
  'startAtLogin', 'closeToTray', 'startHidden', 'collectionPaused', 'updateChannel',
  'windowBounds', 'lastViewState', 'lastPostedDeviceId', 'zoomFactor', 'appUpdate'
];

// Keys that must NOT survive: nothing reads them, or what read them is now a
// constant. Parsed straight out of main.js so the list cannot drift from it.
function retiredKeysFromMain() {
  const declared = /const RETIRED_SETTING_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(main);
  assert.ok(declared, 'main.js must keep one RETIRED_SETTING_KEYS list');
  return [...declared[1].matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
}

const DROPPED_KEYS = [
  'windowBehavior', 'alwaysOnTop', 'floatingBubbleEnabled', 'floatingBubbleTrigger',
  'floatingBubbleContent', 'floatingBubbleCustomLayout', 'floatingBubbleBounds',
  'showTrayIcon', 'trayMode', 'startInTray', 'trayContent',
  'trayCustomLayout', 'showTrayProviderBadge', 'windowToggleShortcut',
  'limitsEnabled', 'limitProviders',
  'serviceProviderDisplayOrder', 'hiddenServiceProviders', 'serviceStatusRefreshMs',
  'refreshMs', 'glassOpacity', 'glassBlur',
  'clients', 'migratedDefaultClients',
  'clientDisplayOrder', 'hiddenClients', 'pinnedClients',
  'archivedClientUsage'
];

function defaultSettingsBlock() {
  const start = main.indexOf('function defaultSettings()');
  assert.ok(start >= 0, 'defaultSettings should exist');
  const end = main.indexOf('\n}', start);
  assert.ok(end > start, 'defaultSettings must close');
  return main.slice(start, end);
}

test('every retained device-local setting still has a default', () => {
  const block = defaultSettingsBlock();
  // A key may be declared as `key: value` or as object shorthand (`key,`).
  const declared = (key) => new RegExp(`^\\s{4}${key}(?::|,)`, 'm').test(block);
  const missing = RETAINED_KEYS.filter((key) => !declared(key));
  assert.deepEqual(missing, [], `retained settings dropped from defaultSettings(): ${missing.join(', ')}`);
});

test('widget-only settings are not declared and are stripped on read', () => {
  const block = defaultSettingsBlock();
  const stillDeclared = DROPPED_KEYS.filter((key) => new RegExp(`^\\s{4}${key}(?::|,)`, 'm').test(block));
  assert.deepEqual(stillDeclared, [], `widget settings must not be declared: ${stillDeclared.join(', ')}`);

  // And an upgraded profile's stored values must be removed rather than ignored,
  // so settings.json stops implying the keys still work.
  // Slice from the comment that introduces the strip list to the call that ends
  // it, using the *last* index so an earlier function definition does not bound it.
  const retired = retiredKeysFromMain();
  const unstripped = DROPPED_KEYS.filter((key) => !retired.includes(key));
  assert.deepEqual(unstripped, [], `widget keys not stripped on read: ${unstripped.join(', ')}`);
});

test('every retired key is stripped on both the read and the write path', () => {
  // One list governs both directions, so a key cannot come back through the path
  // that did not retire it: an old renderer, an old preload, or a hand-written
  // settings.json must all end up with the same fixed behaviour.
  const retired = retiredKeysFromMain();
  for (const key of DROPPED_KEYS) {
    assert.ok(retired.includes(key), `retired list is missing '${key}'`);
  }
  assert.match(main, /withoutRetiredKeys\(withoutInternalOnlyKeys\(stripLegacyLocalLimitSettings\(patch\)\)\)/,
    'a renderer write must not revive a retired key');
  assert.match(main, /return withoutRetiredKeys\(merged\);/,
    'settings.json must be filtered against the same list on read');
});

test('no settings key survives without a writer', () => {
  // The point of this pass: the settings document may only carry what something
  // can still change. A key with no control is how a half-retired feature keeps
  // narrowing collection behind the app's back.
  const writers = new Set([
    // settingsDesktop form controls (plus the folded window-material dropdown).
    'language', 'windowSurface', 'reduceMotion', 'startAtLogin', 'startHidden',
    'closeToTray', 'updateChannel', 'hubMode', 'hubUrl', 'allowInsecureHubHttp', 'deviceId',
    'systemGlass', 'windowsBackdrop', 'secret',
    // shared-UI preferences persisted through the prefs bridge. On the desktop
    // host there is no 偏好 section, so 显示 carries the theme and currency
    // controls and these keys keep a writer on both surfaces.
    'theme', 'currency', 'heatmapMetric', 'homeActiveDaysWindow', 'homeLimitAccountCount',
    // the tray item and the in-app zoom gesture.
    'collectionPaused', 'zoomFactor',
    // operator-editable FX overrides and main-process runtime state.
    'currencyRates', 'windowBounds', 'lastViewState', 'lastPostedDeviceId', 'appUpdate',
    // platform-detected default the window code reads.
    'macosGlassStyle'
  ]);
  const block = defaultSettingsBlock();
  const declared = [...block.matchAll(/^\s{4}([A-Za-z]+):/gm)].map((match) => match[1]);
  const ownerless = declared.filter((key) => !writers.has(key));
  assert.deepEqual(ownerless, [], `settings with no writer: ${ownerless.join(', ')}`);
});

test('the glass preference is normalized to a boolean on both paths', () => {
  // Every consumer reads `systemGlass === false`, but the settings control stored
  // its option string ('system' / 'off'), which made the switch a no-op and left
  // already-upgraded profiles holding a string. Both entry points must normalize.
  assert.match(main, /merged\.systemGlass = parseBoolean\(merged\.systemGlass, true\)/,
    'a stored glass string must normalize on read');
  assert.match(main, /systemGlass: parseBoolean\(patch\.systemGlass \?\? settings\.systemGlass, true\)/,
    'the settings:update path must normalize the glass value');
});

test('the update channel is normalized on both the read and write paths', () => {
  assert.match(main, /merged\.updateChannel = normalizeUpdateChannel\(merged\.updateChannel\)/,
    'a stored channel value must normalize on read');
  assert.match(main, /updateChannel: requestedUpdateChannel/,
    'the settings:update path must store the normalized channel');
  assert.match(main, /if \(updateChannelChanged\) resetAppUpdateChannelCache\(\)/,
    'changing the channel must drop cached release data from the previous channel');
});

test('an implicit device ID stays blank while runtime code keeps the hostname fallback', () => {
  assert.match(
    main,
    /deviceId: normalizeDeviceIdValue\(process\.env\.TOKEN_MONITOR_DEVICE_ID, ''\)/,
    'default settings must not persist the hostname as a configured value'
  );
  assert.match(main, /merged\.deviceId = normalizeDeviceIdValue\(merged\.deviceId, ''\)/,
    'settings reads must preserve an empty device ID');
  assert.match(main, /deviceId: normalizeDeviceIdValue\(patch\.deviceId !== undefined \? patch\.deviceId : settings\.deviceId, ''\)/,
    'clearing the field must persist an empty device ID');
  const runtimeConfig = fs.readFileSync(path.join(root, 'src', 'electron', 'runtimeConfig.js'), 'utf8');
  assert.match(runtimeConfig, /deviceId: settings\.deviceId \|\| context\.defaultDeviceId/,
    'the hostname fallback belongs at the runtime envelope boundary');
});

test('legacy widget settings keys are invalidated like other removed credentials', () => {
  // The device-local quota keys were already stripped before this rewrite; the
  // rewrite must not have removed that cleanup.
  assert.match(main, /LEGACY_LOCAL_LIMIT_SETTING_KEYS/, 'legacy local limit keys must still be stripped');
  assert.match(main, /stripLegacyLocalLimitSettings/, 'the strip helper must still be applied');
});

test('the retired cadence and display keys are gone from both lists at once', () => {
  // Guard the shape of this change: nothing that left the GUI may still be
  // declared as a default, and each retired name must be named exactly once in
  // the strip list.
  const block = defaultSettingsBlock();
  const retired = retiredKeysFromMain();
  const stillDeclared = retired.filter((key) => new RegExp(`^\\s{4}${key}(?::|,)`, 'm').test(block));
  assert.deepEqual(stillDeclared, [], `retired keys still declared: ${stillDeclared.join(', ')}`);
  assert.equal(new Set(retired).size, retired.length, 'the retired list must not repeat a key');
  for (const key of [
    'projectsEnabled', 'historyEnabled', 'historyIntervalMs', 'sessionUsageArchiveEnabled',
    'wslScanEnabled', 'allTimeSince', 'collectionMode', 'collectionIntervalMs',
    'watchEnabled', 'watchDebounceMs', 'syncUploadIntervalMs',
    'discordRpcEnabled', 'exportAutoEnabled', 'exportDir', 'exportIntervalMs',
    'customModelPricing', 'automaticAppUpdates',
    'viewDisplayOrder', 'hiddenViews', 'homeModuleOrder', 'hiddenHomeModules',
    'themeColors', 'vendorColors', 'showLiveDot', 'showToolIcons', 'titleIconOnly',
    'showCompactTotalTokens', 'showHomeLimitBars', 'showHomeLimitProviderNames',
    'showLimitSource', 'showLimitUsed', 'maskLimitAccountEmails',
    'limitProviderOrder', 'homeLimitProviderOrder', 'hiddenHomeLimitProviders'
  ]) {
    assert.ok(retired.includes(key), `retired list lost '${key}'`);
  }
});

test('credentials keep their existing shape', () => {
  // secret lives in credentials.json, not settings.json; the rewrite must not
  // have moved it, or every existing install would need re-authenticating.
  const credentialStore = fs.readFileSync(path.join(root, 'src', 'shared', 'credentialStore.js'), 'utf8');
  assert.match(credentialStore, /CREDENTIAL_SETTING_PATHS/, 'the credential path map must still exist');
  assert.match(credentialStore, /clientSecret/, 'the Hub secret path must be unchanged');
  assert.match(main, /stripCredentialSettings|credentialSettingsForRenderer/, 'settings.json must still be written without credentials');
});

test('every user-facing setting of the redesigned surface has a control', () => {
  // The redesigned desktop settings keep three groups (显示/行为/连接); the keys
  // that left the GUI stay valid settings.json keys configurable through env and
  // the settings document — this test only requires a control for the keys the
  // surface still presents.
  const view = fs.readFileSync(path.join(root, 'src', 'shared-ui', 'views', 'settingsDesktop.js'), 'utf8');
  const uiSource = [
    fs.readFileSync(path.join(root, 'src', 'shared-ui', 'app.js'), 'utf8'),
    ...fs.readdirSync(path.join(root, 'src', 'shared-ui', 'views'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(root, 'src', 'shared-ui', 'views', name), 'utf8'))
  ].join('\n');

  // Fields the desktop settings form renders.
  const controllable = [
    'language', 'windowSurface', 'reduceMotion',
    'startAtLogin', 'startHidden', 'closeToTray',
    'deviceId', 'hubMode', 'hubUrl', 'allowInsecureHubHttp'
  ];
  // Fields are produced by checkbox()/dropdownField()/textField(), so a key
  // appears as the first argument of one of those helpers (the surface control
  // is the one folded key, handled through settingsPatchForSurface).
  const missing = controllable.filter((key) => (
    !new RegExp(`(?:checkbox|dropdownField|textField|numberField)\\('${key}'`).test(view)
    && !view.includes(`name="${key}"`)
  ));
  assert.deepEqual(missing, [], `retained settings with no control: ${missing.join(', ')}`);
  assert.match(view, /settingsPatchForSurface/, 'the window-material folding must be present');

  // Preferences the shared UI persists through its prefs bridge. The ordering /
  // hidden-set keys and the JSON colour/rate maps left the GUI with the redesign
  // — they remain valid settings.json keys, but no view reads them, so listing
  // them here would fail. Only what some view still touches belongs in this list.
  const prefsBacked = [
    'heatmapMetric'
  ];
  const orphaned = prefsBacked.filter((key) => !uiSource.includes(key));
  assert.deepEqual(
    orphaned,
    [],
    `preferences with no UI surface anywhere: ${orphaned.join(', ')}`
  );
});

test('main-process runtime state stays out of the renderer surface', () => {
  const declared = /const INTERNAL_ONLY_SETTING_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(main);
  assert.ok(declared, 'the internal-state key list must exist');
  const keys = [...declared[1].matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(keys, ['windowBounds', 'lastViewState',
    'lastPostedDeviceId', 'appUpdate']);

  // Both the settings read for the renderer and the write path go through it, so
  // neither can leak or clobber runtime state.
  assert.match(main, /withoutInternalOnlyKeys\(stripLegacyLocalLimitSettings\(settings\)\)/,
    'the renderer snapshot must omit internal state');
  assert.match(main, /withoutInternalOnlyKeys\(stripLegacyLocalLimitSettings\(patch\)\)/,
    'a renderer write must not reach internal state');

  // The omission is only safe because no view reads these names.
  const uiDir = path.join(root, 'src', 'shared-ui');
  const scan = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? scan(path.join(dir, entry.name)) : (entry.name.endsWith('.js') ? [fs.readFileSync(path.join(dir, entry.name), 'utf8')] : [])
  ));
  const offenders = keys.filter((key) => scan(uiDir).some((source) => new RegExp(`\\b${key}\\b`).test(source)));
  assert.deepEqual(offenders, [], `views read main-process runtime state: ${offenders.join(', ')}`);
});

test('UI flags cannot land on a real setting key', () => {
  // The flag store writes straight into settings.json, so the namespace is the only
  // thing separating a dismissed notice from a clobbered preference.
  assert.match(main, /function isUiFlagKey\(key\) \{\n\s+return String\(key \|\| ''\)\.startsWith\(UI_FLAG_PREFIX\);/);
  assert.match(main, /if \(!isUiFlagKey\(key\)\) return false;/);
  assert.match(main, /if \(!isUiFlagKey\(key\)\) return null;/);
});

test('native chrome colours come from the live Fluent surface tokens', () => {
  // The window background and the Windows caption overlay must equal what the
  // stylesheet paints; the pre-redesign greys are what made the title strip and the
  // first paint disagree with the app.
  assert.match(main, /light: \{ background: '#f5f5f5', glyph: '#242424' \}/);
  assert.match(main, /dark: \{ background: '#141414', glyph: '#ffffff' \}/);
  assert.match(main, /nativeTheme\.themeSource = /, 'native controls must follow the app theme');
  assert.doesNotMatch(main, /'#f4f5f7'|'#0b0c0e'/, 'the retired greys must not come back');
});

test('the desktop Hub path deliberately ignores the proxy environment', () => {
  // Operator decision: a workstation's HTTP(S)_PROXY must not silently become the
  // sync path. Only the per-provider quota collectors honour proxy env today, so a
  // future "consistency" fix that routes these through outboundFetch is a change of
  // behaviour and needs a new decision, not a refactor.
  assert.doesNotMatch(main, /require\('\.\.\/shared\/outboundFetch'\)/, 'the desktop app must not proxy Hub traffic');
  assert.match(main, /postSyncPayload\(fetch, url/);
  assert.match(main, /fetchBufferedWithTimeout\(fetch, /);
});

test('waking from sleep re-establishes the runtime instead of waiting for a timer', () => {
  assert.match(main, /powerMonitor\.on\('resume', handleSystemResume\)/);
  assert.match(main, /resumeReconnectTimer = setTimeout\(\(\) => \{ startMode\(\); \}, RESUME_RECONNECT_DELAY_MS\)/);
});
