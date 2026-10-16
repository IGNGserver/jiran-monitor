'use strict';

// DeepSeek Harness (dsh) is read by tokscale, not by a local parser. What is
// left to test on our side is the seam between the two: the id rename, the
// watch-root resolution, and the fact that an id tokscale does not know is a
// hard failure of the whole scan rather than a dropped filter.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveDeepSeekHarnessHome,
  resolveDeepSeekHarnessSessionsDir
} = require('../../src/shared/deepseekHarnessPaths');
const { normalizeGraphClientIds, tokscaleClientFilter } = require('../../src/shared/collector');
const { normalizeClientName } = require('../../src/shared/usage');

test('deepseek-harness is renamed to tokscale upstream id dsh', () => {
  assert.equal(tokscaleClientFilter('deepseek-harness'), 'dsh');
});

test('the rename applies inside a mixed client list without disturbing others', () => {
  assert.equal(tokscaleClientFilter('claude,deepseek-harness,codex'), 'claude,dsh,codex');
});

test('other tracked ids pass through unchanged', () => {
  assert.equal(tokscaleClientFilter('claude,commandcode'), 'claude,commandcode');
});

test('antigravity widens to its CLI and IDE-extension sub-source ids', () => {
  // `antigravity-cli` owns the CLI's own SQLite root; `antigravity-extension`
  // owns the IDE's conversations store, parsed from disk since tokscale 4.18.
  // Both belong to the umbrella `antigravity` client.
  assert.equal(tokscaleClientFilter('antigravity'), 'antigravity,antigravity-cli,antigravity-extension');
});

// tokscale 4.14 split Oh My Pi out of `pi` into its own `omp` client owning
// ~/.omp/agent/sessions, which 4.13 had read under `pi`. Requesting only `pi`
// now returns zero for that root, so the tracked `pi` client must widen to both.
test('pi widens to omp so the Oh My Pi root is still scanned', () => {
  assert.equal(tokscaleClientFilter('pi'), 'pi,omp');
});

test('the pi alias survives alongside other clients and is deduplicated', () => {
  assert.equal(tokscaleClientFilter('claude,pi'), 'claude,pi,omp');
  // A caller that already names the upstream id must not duplicate it.
  assert.equal(tokscaleClientFilter('pi,omp'), 'pi,omp');
});

test('the filter is deduplicated and order-preserving', () => {
  assert.equal(tokscaleClientFilter('claude,dsh,claude'), 'claude,dsh');
  // A caller that already speaks the upstream id must not produce a duplicate.
  assert.equal(tokscaleClientFilter('deepseek-harness,dsh'), 'dsh');
});

test('an empty client list stays empty (never expands to all clients)', () => {
  assert.equal(tokscaleClientFilter(''), '');
  assert.equal(tokscaleClientFilter(undefined), '');
});

test('tokscale folds the upstream dsh id back onto our display id', () => {
  assert.equal(normalizeClientName('dsh'), 'deepseek-harness');
  assert.equal(normalizeClientName('DeepSeek Harness'), 'deepseek-harness');
  assert.equal(normalizeClientName('deepseek-harness'), 'deepseek-harness');
});

test('the upstream omp id folds back onto the tracked pi client', () => {
  assert.equal(normalizeClientName('omp'), 'pi');
  assert.equal(normalizeClientName('Oh My Pi'), 'pi');
  assert.equal(normalizeClientName('pi'), 'pi');
});

test('DSH_HOME is honoured and wins over the home default', () => {
  const resolved = resolveDeepSeekHarnessHome({
    homeDir: '/home/someone',
    env: { DSH_HOME: '/custom/dsh' }
  });
  assert.equal(resolved, path.resolve('/custom/dsh'));
});

test('the sessions watch root sits under the resolved DSH_HOME', () => {
  assert.equal(
    resolveDeepSeekHarnessSessionsDir({ homeDir: '/home/someone', env: {} }),
    path.join(path.resolve('/home/someone'), '.dsh', 'sessions')
  );
});

test('a ~ in DSH_HOME expands against the given home', () => {
  assert.equal(
    resolveDeepSeekHarnessHome({ homeDir: '/home/someone', env: { DSH_HOME: '~/custom' } }),
    path.resolve('/home/someone/custom')
  );
});

test('the watch root defaults to ~/.dsh/sessions on the real host', () => {
  const dir = resolveDeepSeekHarnessSessionsDir({ env: {} });
  assert.equal(dir, path.join(os.homedir(), '.dsh', 'sessions'));
});

// tokscale's `graph` output names clients with its own ids. The period path folds
// them through normalizeClientName; the graph path must too, or the same client
// appears under two ids (period totals vs the Trends stack) and a renamed client
// leaks its upstream spelling into the UI.
function graphOf(clients) {
  return { contributions: [{ date: '2026-09-18', clients }] };
}

test('graph client ids are folded onto our tracked ids', () => {
  const graph = normalizeGraphClientIds(graphOf([
    { client: 'dsh', modelId: 'm', tokens: { input: 1 }, cost: 0, messages: 1 },
    { client: 'antigravity-cli', modelId: 'm', tokens: { input: 2 }, cost: 0, messages: 1 },
    { client: 'claude', modelId: 'm', tokens: { input: 3 }, cost: 0, messages: 1 }
  ]));
  assert.deepEqual(graph.contributions[0].clients.map((c) => c.client), [
    'deepseek-harness', 'antigravity', 'claude'
  ]);
});

test('graph client id folding is idempotent', () => {
  const once = normalizeGraphClientIds(graphOf([
    { client: 'dsh', modelId: 'm', tokens: { input: 1 } },
    { client: 'deepseek-harness', modelId: 'm', tokens: { input: 1 } }
  ]));
  const twice = normalizeGraphClientIds(once);
  assert.deepEqual(twice.contributions[0].clients.map((c) => c.client), [
    'deepseek-harness', 'deepseek-harness'
  ]);
});

test('graph normalization tolerates empty and malformed payloads', () => {
  assert.equal(normalizeGraphClientIds(null), null);
  assert.deepEqual(normalizeGraphClientIds({}), {});
  assert.deepEqual(normalizeGraphClientIds({ contributions: 'nope' }), { contributions: 'nope' });
  // A row without a clients array, and a non-object entry, must not throw.
  const graph = normalizeGraphClientIds({
    contributions: [{ date: '2026-09-18' }, { date: '2026-09-19', clients: [null, 'x', { client: 'dsh' }] }]
  });
  assert.equal(graph.contributions[1].clients[2].client, 'deepseek-harness');
});
