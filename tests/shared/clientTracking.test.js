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
  const { TOKSCALE_CLIENT_ALIASES } = require('../../src/shared/collector');
  const unsupportedAliases = Object.values(TOKSCALE_CLIENT_ALIASES).flat().filter((alias) => !supported.has(alias));
  assert.deepEqual(unsupportedAliases, []);
  // Neither Qoder site is in the enum at all, so passing one through would fail
  // the whole scan for every other client in the same call. That is the reason
  // LOCAL_PARSED_CLIENTS in collector.js has to filter both ids out of the CSV,
  // and this assertion is what fails if tokscale ever grows a Qoder entry (at
  // which point the local adapter becomes redundant and should be revisited).
  for (const client of ['qoder', 'qodercn']) {
    assert.ok(!supported.has(client), `tokscale unexpectedly accepts ${client}`);
  }
});

test('normalizeClientsCsv trims, lowercases, and drops empty entries', () => {
  assert.equal(normalizeClientsCsv(' Claude , Codex,,hermes '), 'claude,codex,hermes');
  assert.equal(normalizeClientsCsv(undefined), '');
  assert.equal(normalizeClientsCsv(''), '');
});

// ---------------------------------------------------------------------------
// The Android read client renders the same 55 harnesses, and it keeps its own
// copy of the brand table (there is no shared code between the surfaces). With
// every harness collected on every surface, an id missing there is not a hidden
// row any more — it is a row with a hashed colour and a fallback name.
// ---------------------------------------------------------------------------
test('Android branding covers every tracked client with the shared-UI values', async () => {
  const { pathToFileURL } = require('node:url');
  const fs = require('node:fs');
  const path = require('node:path');
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
  for (const client of TRACKED_CLIENTS.split(',')) {
    // Labels are the same string on every surface.
    assert.equal(labels.get(client), data.CLIENT_LABELS[client],
      `Android label for "${client}" is missing or differs from the shared UI`);
    // Colours are presence-checked only: the pitch-dark theme replaces a brand's
    // pure black with a visible near-black, and
    // `npm run verify:android-fluent-contrast` owns that rule. A missing entry
    // here would silently fall back to the hashed colour instead.
    assert.ok(
      colors.has(client),
      `Android has no colour for "${client}", so it renders with the hashed fallback instead of the brand mark`
    );
  }
});

// A brand mark shared by two ids is an alias, not duplicate artwork, and an id
// with no mark at all has to be a written decision rather than drift.
test('Android client marks resolve through aliases with documented gaps', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const iconsPath = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java',
    'com', 'igng', 'tokenmonitor', 'android', 'ui', 'components', 'ClientIcons.kt');
  const kt = fs.readFileSync(iconsPath, 'utf8');

  function mapBody(marker) {
    const start = kt.indexOf(marker);
    assert.ok(start > 0, `${marker} must exist in ClientIcons.kt`);
    const open = kt.indexOf('mapOf(', start);
    let depth = 0;
    for (let i = kt.indexOf('(', open); i < kt.length; i += 1) {
      if (kt[i] === '(') depth += 1;
      else if (kt[i] === ')') { depth -= 1; if (!depth) return kt.slice(open, i); }
    }
    throw new Error(`${marker} is unbalanced`);
  }

  const drawables = mapBody('val drawables');
  const aliasBody = mapBody('val aliases');
  const drawableIds = new Set(Array.from(drawables.matchAll(/"([a-z0-9_-]+)"\s+to\s+R\.drawable\./g), (m) => m[1]));
  const aliases = new Map(Array.from(aliasBody.matchAll(/"([a-z0-9_-]+)"\s+to\s+"([a-z0-9_-]+)"/g), (m) => [m[1], m[2]]));

  for (const [id, target] of aliases) {
    assert.ok(drawableIds.has(target), `alias "${id}" points at "${target}", which has no drawable`);
    assert.ok(!drawableIds.has(id), `"${id}" has its own drawable, so the alias entry is dead weight`);
  }

  // openclaw / antigravity are the documented filter-and-gradient skips; proma is
  // simply not vendored yet. Anything else that appears here is a regression.
  const NO_MARK = {
    openclaw: 'its SVG needs a filter/transform, so the vector is skipped by design',
    antigravity: 'its SVG needs a filter/transform, so the vector is skipped by design',
    proma: 'not vendored as a vector yet; the monogram is the fallback'
  };
  for (const client of TRACKED_CLIENTS.split(',')) {
    const resolved = drawableIds.has(client) || (aliases.has(client) && drawableIds.has(aliases.get(client)));
    if (!resolved) {
      assert.ok(NO_MARK[client], `Android has no mark for "${client}" and no written reason`);
    } else {
      assert.ok(
        !NO_MARK[client] || client === 'proma',
        `"${client}" now has a mark — drop it from the documented-gap list`
      );
    }
  }
});
