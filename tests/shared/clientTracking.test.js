'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  TRACKED_CLIENTS,
  normalizeClientsCsv
} = require('../../src/shared/clientTracking');

test('the tracked set is one non-empty, normalized csv', () => {
  assert.equal(typeof TRACKED_CLIENTS, 'string');
  const clients = TRACKED_CLIENTS.split(',');
  assert.ok(clients.length >= 50, `expected the wired client set, saw ${clients.length}`);
  assert.equal(normalizeClientsCsv(TRACKED_CLIENTS), TRACKED_CLIENTS);
  assert.equal(new Set(clients).size, clients.length, 'a client id must not repeat');
});

test('the tracked set still covers every current tokscale-supported tool', () => {
  const clients = TRACKED_CLIENTS.split(',');
  for (const client of ['cline', 'kimi', 'qwen', 'grok', 'copilot', 'pi', 'zed', 'kilocode', 'zcode', 'kiro', 'codebuddy', 'workbuddy']) {
    assert.ok(clients.includes(client), `${client} should be tracked`);
  }
  for (const client of ['claude-desktop', 'deepseek-harness']) {
    assert.ok(clients.includes(client), `${client} should be tracked`);
  }
});

test('micode and both Qoder sites are tracked (the selection surface is gone)', () => {
  // micode double-counts claude-import sessions in mimocode.db until tokscale
  // dedups them, and the Qoder sites are estimate-marked local adapters. They
  // used to be opt-in through Settings → Tracked tools; with that UI removed,
  // excluding them would make the data unreachable, so they are locked in like
  // every other wired client.
  const clients = TRACKED_CLIENTS.split(',');
  for (const client of ['micode', 'qoder', 'qodercn']) {
    assert.ok(clients.includes(client), `${client} must be tracked`);
  }
});

test('the two Qoder sites sit adjacent', () => {
  // Cosmetic but load-bearing for every client list a view renders: the two
  // editions of one product belong next to each other rather than scattered by
  // insertion history.
  const clients = TRACKED_CLIENTS.split(',');
  assert.equal(clients.indexOf('qoder'), clients.indexOf('qodercn') - 1);
});

test('every tracked client is accepted by bundled tokscale', () => {
  const locallyParsedClients = new Set(['proma', 'claude-desktop', 'qoder', 'qodercn']);
  // Ids we track but tokscale spells differently. The collector renames them
  // before building `--client`, so the upstream spelling is what has to exist in
  // the enum. A wrong id is a hard usage error (exit 2), not a silently dropped
  // filter — which is why this test checks the rename.
  const tokscaleSpellings = { 'deepseek-harness': 'dsh' };
  const result = spawnSync(process.execPath, [require.resolve('tokscale/bin.js'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const help = `${result.stdout || ''}\n${result.stderr || ''}`;
  const possibleValues = help.match(/\[possible values: ([^\]]+)\]/);
  assert.ok(possibleValues, 'tokscale --help should list --client possible values');
  const supported = new Set(possibleValues[1].split(',').map((client) => client.trim()).filter(Boolean));
  const unsupported = TRACKED_CLIENTS.split(',').filter((client) => {
    if (locallyParsedClients.has(client)) return false;
    return !supported.has(tokscaleSpellings[client] || client);
  });
  assert.deepEqual(unsupported, []);
  // Alias ids ride the same --client enum, and an unknown id fails the whole
  // scan — so a stale alias (a rename upstream, a version pin that predates the
  // id) breaks every client in the call, not just the aliased one. 4.19's
  // `antigravity-extension` is the current case.
  const { TOKSCALE_CLIENT_ALIASES, tokscaleClientsCsv } = require('../../src/shared/collector');
  const { LOCAL_USAGE_CLIENT_IDS } = require('../../src/shared/localUsageAdapters');
  const unsupportedAliases = Object.values(TOKSCALE_CLIENT_ALIASES).flat().filter((alias) => !supported.has(alias));
  assert.deepEqual(unsupportedAliases, []);
  // tokscale 4.22 added `qoder` (scanning both Global and CN dirs under one id)
  // and `proma`, while `qodercn` is still absent from `--client`. Filtering all
  // local adapters out via tokscaleClientsCsv keeps Global/CN separate, preserves
  // native Qoder billing meters/WSL markers, and prevents double-counting.
  assert.ok(!supported.has('qodercn'), 'tokscale unexpectedly accepts qodercn');
  const forwarded = new Set(tokscaleClientsCsv(TRACKED_CLIENTS).split(',').filter(Boolean));
  for (const client of LOCAL_USAGE_CLIENT_IDS) {
    assert.ok(!forwarded.has(client), `${client} must remain locally parsed, not forwarded to tokscale`);
  }
});

test('normalizeClientsCsv trims, lowercases, and drops empty entries', () => {
  assert.equal(normalizeClientsCsv(' Claude , Codex,,hermes '), 'claude,codex,hermes');
  assert.equal(normalizeClientsCsv(undefined), '');
  assert.equal(normalizeClientsCsv(''), '');
});

// ---------------------------------------------------------------------------
// The Android read client renders the same tracked harnesses and quota
// providers, and keeps its own copy of the brand table. Every tracked client
// AND every limit provider must have a label, brand colour, and resolved icon
// drawable on Android, synchronized from src/shared-ui/icons/manifest.json via
// `npm run sync:icons`.
// ---------------------------------------------------------------------------
test('Android branding covers every tracked client and limit provider with the shared-UI values', async () => {
  const { pathToFileURL } = require('node:url');
  const fs = require('node:fs');
  const path = require('node:path');
  const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limitProviders');
  const dataPath = path.join(__dirname, '..', '..', 'src', 'shared-ui', 'core', 'data.js');
  const data = await import(pathToFileURL(dataPath).href);
  const brandPath = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java',
    'com', 'igng', 'tokenmonitor', 'android', 'ui', 'components', 'ClientBranding.kt');
  const brand = fs.readFileSync(brandPath, 'utf8');

  function mapEntries(name) {
    const start = brand.indexOf(name);
    assert.ok(start > 0, `${name} must exist in ClientBranding.kt`);
    const open = brand.indexOf('mapOf(', start);
    let depth = 0;
    let end = -1;
    for (let i = brand.indexOf('(', open); i < brand.length; i += 1) {
      if (brand[i] === '(') depth += 1;
      else if (brand[i] === ')') { depth -= 1; if (!depth) { end = i; break; } }
    }
    const body = brand.slice(open, end);
    const out = new Map();
    for (const match of body.matchAll(/"([a-z0-9_-]+)"\s+to\s+(?:"([^"]*)"|Color\((0x[0-9A-Fa-f]+)\))/g)) {
      out.set(match[1], match[2] ?? match[3]);
    }
    return out;
  }

  const labels = mapEntries('val labels');
  const colors = mapEntries('val colors');
  const allIds = new Set([...TRACKED_CLIENTS.split(','), ...LIMIT_PROVIDER_IDS]);
  for (const client of allIds) {
    const expectedLabel = data.CLIENT_LABELS[client] || data.PROVIDER_LABELS[client];
    assert.equal(labels.get(client), expectedLabel,
      `Android label for "${client}" is missing or differs from the shared UI`);
    assert.ok(
      colors.has(client),
      `Android has no colour for "${client}", so it renders with the hashed fallback instead of the brand mark`
    );
    assert.ok(
      Boolean(data.CLIENT_COLORS[client]),
      `Shared UI CLIENT_COLORS is missing "${client}"`
    );
  }
});

test('Android client marks cover every tracked client and limit provider with zero gaps and match manifest.json', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limitProviders');
  const rootDir = path.join(__dirname, '..', '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'src', 'shared-ui', 'icons', 'manifest.json'), 'utf8'));
  const iconsPath = path.join(rootDir, 'android', 'app', 'src', 'main', 'java',
    'com', 'igng', 'tokenmonitor', 'android', 'ui', 'components', 'ClientIcons.kt');
  const kt = fs.readFileSync(iconsPath, 'utf8');

  function collectionBody(marker, opener) {
    const start = kt.indexOf(marker);
    assert.ok(start > 0, `${marker} must exist in ClientIcons.kt`);
    const open = kt.indexOf(opener, start);
    let depth = 0;
    for (let i = kt.indexOf('(', open); i < kt.length; i += 1) {
      if (kt[i] === '(') depth += 1;
      else if (kt[i] === ')') { depth -= 1; if (!depth) return kt.slice(open, i); }
    }
    throw new Error(`${marker} is unbalanced`);
  }

  const drawables = collectionBody('val drawables', 'mapOf(');
  const aliasBody = collectionBody('val aliases', 'mapOf(');
  const multicolorBody = collectionBody('val multicolorIds', 'setOf(');
  const drawableIds = new Set(Array.from(drawables.matchAll(/"([a-z0-9_-]+)"\s+to\s+R\.drawable\./g), (m) => m[1]));
  const aliases = Object.fromEntries(Array.from(aliasBody.matchAll(/"([a-z0-9_-]+)"\s+to\s+"([a-z0-9_-]+)"/g), (m) => [m[1], m[2]]));
  const multicolorIds = Array.from(multicolorBody.matchAll(/"([a-z0-9_-]+)"/g), (m) => m[1]).sort();

  assert.deepEqual(aliases, manifest.aliases, 'ClientIcons.kt aliases must mirror manifest.json');
  assert.deepEqual(multicolorIds, [...manifest.colorIcons].sort(), 'ClientIcons.kt multicolorIds must mirror manifest.json');

  for (const [id, target] of Object.entries(aliases)) {
    assert.ok(drawableIds.has(target), `alias "${id}" points at "${target}", which has no drawable`);
    assert.ok(!drawableIds.has(id), `"${id}" has its own drawable, so the alias entry is dead weight`);
  }

  for (const client of new Set([...TRACKED_CLIENTS.split(','), ...LIMIT_PROVIDER_IDS])) {
    const resolved = drawableIds.has(client) || (aliases[client] && drawableIds.has(aliases[client]));
    assert.ok(resolved, `Android has no mark for "${client}" — add its SVG and run npm run sync:icons`);
  }
});

test('canonical client SVGs, Android drawables, website mirror, app.css and legacy assets stay normalized and synchronized', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { normalizeAndroidPathData } = require('../../scripts/sync-client-icons');
  const rootDir = path.join(__dirname, '..', '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'src', 'shared-ui', 'icons', 'manifest.json'), 'utf8'));
  const clientsDir = path.join(rootDir, 'src', 'shared-ui', 'icons', 'clients');
  const androidDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'res', 'drawable');
  const websiteDir = path.join(rootDir, 'website', 'src', 'assets', 'icons', 'clients');
  const legacyDir = path.join(rootDir, 'assets', 'icons');
  const colorSet = new Set(manifest.colorIcons);

  const svgs = fs.readdirSync(clientsDir).filter((f) => f.endsWith('.svg')).sort();
  assert.ok(svgs.length >= 60, `expected canonical SVG set, found ${svgs.length}`);

  const expectedAndroidXmls = new Set();
  for (const file of svgs) {
    const slug = file.replace(/\.svg$/, '');
    const svgText = fs.readFileSync(path.join(clientsDir, file), 'utf8');
    const titleCount = (svgText.match(/<title>/g) || []).length;
    assert.ok(titleCount <= 1, `${file} has duplicate <title> elements`);
    assert.match(svgText, /viewBox="0 0 24 24"/, `${file} must be normalized to viewBox="0 0 24 24"`);
    assert.doesNotMatch(svgText, /\btransform=/, `${file} must not contain unbaked transform attributes`);
    if (!colorSet.has(slug)) {
      assert.match(svgText, /currentColor/, `monochrome ${file} must use currentColor`);
      assert.doesNotMatch(svgText, /fill\s*[:=]\s*["']?#(?:fff|ffffff)\b/i, `monochrome ${file} must not hardcode white fill`);
    }

    // Android drawable parity
    const xmlName = `client_${slug.replace(/-/g, '_')}.xml`;
    expectedAndroidXmls.add(xmlName);
    const xmlPath = path.join(androidDir, xmlName);
    assert.ok(fs.existsSync(xmlPath), `missing Android drawable ${xmlName} — run npm run sync:icons`);
    const xmlText = fs.readFileSync(xmlPath, 'utf8');
    assert.match(xmlText, /android:viewportWidth="24"/, `${xmlName} viewportWidth must be 24`);
    assert.match(xmlText, /android:viewportHeight="24"/, `${xmlName} viewportHeight must be 24`);
    if (/fill-rule\s*[:=]\s*["']?evenodd/i.test(svgText)) {
      assert.match(xmlText, /android:fillType="evenOdd"/, `${xmlName} lost fillType="evenOdd"`);
    }
    if (/fill-opacity\s*[:=]/i.test(svgText)) {
      assert.match(xmlText, /android:fillAlpha=/, `${xmlName} lost fillAlpha`);
    }
    const pathDatas = [...xmlText.matchAll(/android:pathData="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(pathDatas.length > 0, `${xmlName} must contain at least one android:pathData`);
    for (const rawPathData of pathDatas) {
      assert.equal(
        rawPathData,
        normalizeAndroidPathData(rawPathData, xmlName),
        `${xmlName} contains unexpanded SVG pathData (e.g. compact arc flags) that Jetpack Compose PathParser silently drops — run npm run sync:icons`
      );
    }

    // Website mirror byte parity
    const webPath = path.join(websiteDir, file);
    assert.ok(fs.existsSync(webPath), `missing website icon mirror ${file} — run npm run sync:icons`);
    assert.deepEqual(fs.readFileSync(webPath), fs.readFileSync(path.join(clientsDir, file)),
      `website icon ${file} drifted from src/shared-ui/icons/clients/${file}`);
  }

  // No stale Android client_*.xml or website SVGs
  const actualAndroidXmls = fs.readdirSync(androidDir).filter((f) => f.startsWith('client_') && f.endsWith('.xml')).sort();
  assert.deepEqual(actualAndroidXmls, [...expectedAndroidXmls].sort(), 'Android drawable/ has stale client_*.xml files');
  const actualWebsiteSvgs = fs.readdirSync(websiteDir).filter((f) => f.endsWith('.svg')).sort();
  assert.deepEqual(actualWebsiteSvgs, svgs, 'website/src/assets/icons/clients/ has stale SVG files');

  // Shared-UI app.css dark-mode color exclusions, data.js ICON_ALIASES, and website COLOR_SLUGS stay aligned
  const dataJs = fs.readFileSync(path.join(rootDir, 'src', 'shared-ui', 'core', 'data.js'), 'utf8');
  const aliasBlock = dataJs.match(/const ICON_ALIASES = \{([\s\S]*?)\n\};/)[1];
  const jsAliases = Object.fromEntries(
    [...aliasBlock.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'([a-z0-9-]+)'/gm)].map((m) => [m[1], m[2]])
  );
  assert.deepEqual(jsAliases, manifest.aliases, 'data.js ICON_ALIASES must mirror manifest.json');

  const appCss = fs.readFileSync(path.join(rootDir, 'src', 'shared-ui', 'styles', 'app.css'), 'utf8');
  const darkRule = appCss.match(/html\[data-theme="dark"\] \.client-icon([^\n{]+)\{/);
  assert.ok(darkRule, 'app.css dark-mode .client-icon rule must exist');
  const cssColorSlugs = [...darkRule[1].matchAll(/:not\(\[src\$="\/([a-z0-9-]+)\.svg"\]\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(cssColorSlugs, [...manifest.colorIcons].sort(), 'app.css dark-mode exclusions must match manifest.json colorIcons');

  const websiteIconsTs = fs.readFileSync(path.join(rootDir, 'website', 'src', 'data', 'icons.ts'), 'utf8');
  const webColorBlock = websiteIconsTs.match(/const COLOR_SLUGS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(webColorBlock, 'website/src/data/icons.ts COLOR_SLUGS must exist');
  const webColorSlugs = [...webColorBlock[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(webColorSlugs, [...manifest.colorIcons].sort(), 'website COLOR_SLUGS must match manifest.json colorIcons');

  // Legacy assets/icons/ holds only macOS tray templates, no retired client SVGs
  const legacySvgs = fs.readdirSync(legacyDir).filter((f) => f.endsWith('.svg'));
  assert.deepEqual(legacySvgs, [], `retired SVGs remain in assets/icons/: ${legacySvgs.join(', ')}`);
});

test('normalizeAndroidPathData expands compact SVG arc flags and consecutive decimals for Jetpack Compose PathParser', () => {
  const { normalizeAndroidPathData } = require('../../scripts/sync-client-icons');
  assert.equal(
    normalizeAndroidPathData('M1 2a5.947 5.947 0 005.827-4.756A5.962 5.962 0 0110.205 0a1.273 1.273 0 100 2.547.503.503 0 11-.975 0z'),
    'M 1 2 a 5.947 5.947 0 0 0 5.827 -4.756 A 5.962 5.962 0 0 1 10.205 0 a 1.273 1.273 0 1 0 0 2.547 a 0.503 0.503 0 1 1 -0.975 0 z'
  );
  assert.equal(
    normalizeAndroidPathData('m1 2 3 4M5 6 7 8'),
    'm 1 2 l 3 4 M 5 6 L 7 8'
  );
});
