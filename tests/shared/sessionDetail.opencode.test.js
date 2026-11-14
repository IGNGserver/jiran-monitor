'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const { readSessionDetail } = require('../../src/shared/sessionDetail');

const maybe = sqlite ? test : test.skip;

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 5, 4, 10, 0, 0);
const T1 = Date.UTC(2026, 5, 4, 10, 0, 5);
const T2 = Date.UTC(2026, 5, 4, 10, 1, 0);
const T3 = Date.UTC(2026, 5, 4, 10, 1, 5);
const T4 = Date.UTC(2026, 5, 4, 10, 1, 9);

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocdetail-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('s1', null, 'Greeting', T0, T2);
  const insM = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
  const asst = (cost, tokens, createdMs) => JSON.stringify({ role: 'assistant', providerID: 'opencode', cost, tokens, time: { created: createdMs } });
  const user = (createdMs) => JSON.stringify({ role: 'user', time: { created: createdMs } });
  insM.run('m0', 's1', T0, T0, user(T0));
  insM.run('m1', 's1', T1, T1, asst(0.5, { total: 9441, input: 9416, output: 9, reasoning: 16, cache: { read: 0, write: 0 } }, T1));
  insM.run('m2', 's1', T2, T2, user(T2));
  insM.run('m3', 's1', T3, T3, asst(0.25, { total: 100, input: 50, output: 30, reasoning: 5, cache: { read: 15, write: 0 } }, T3));
  insM.run('m4', 's1', T4, T4, asst(0.1, { total: 200, input: 120, output: 40, reasoning: 0, cache: { read: 40, write: 0 } }, T4));
  const insP = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');
  insP.run('p0', 'm0', 's1', T0, T0, JSON.stringify({ type: 'text', text: 'Hello there' }));
  insP.run('p1', 'm2', 's1', T2, T2, JSON.stringify({ type: 'text', text: 'Do a search' }));
  insP.run('p2', 'm3', 's1', T3, T3, JSON.stringify({ type: 'tool', tool: 'websearch' }));
  db.close();
  return file;
}

maybe('readSessionDetail(opencode) groups exchanges with real per-turn cost', () => {
  const file = makeFixture();
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 's1', period: 'total',
    deps: { dbPaths: [file], sqlite, now: () => T4 + 1000 }
  });
  assert.strictEqual(detail.found, true);
  assert.strictEqual(detail.exchanges.length, 2);

  const [ex1, ex2] = detail.exchanges;
  assert.strictEqual(ex1.promptPreview, 'Hello there');
  assert.strictEqual(ex1.turnCount, 1);
  assert.strictEqual(ex1.tokens.output, 25); // 9 output + 16 disjoint reasoning
  assert.strictEqual(ex1.tokens.total, 9441); // 9416 + 9 + 16 reasoning (+0 cache)
  assert.strictEqual(ex1.costEstimate, 0.5);

  assert.strictEqual(ex2.promptPreview, 'Do a search');
  assert.strictEqual(ex2.turnCount, 2);
  assert.strictEqual(ex2.tokens.output, 75); // (30+5 reasoning) + 40
  assert.strictEqual(ex2.tokens.total, 300); // (50+30+15+5) + (120+40+40)
  assert.ok(Math.abs(ex2.costEstimate - 0.35) < 1e-9);
});

maybe('readSessionDetail(opencode) totals use real cost + DB token totals', () => {
  const file = makeFixture();
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 's1', period: 'total',
    deps: { dbPaths: [file], sqlite, now: () => T4 + 1000 }
  });
  assert.strictEqual(detail.totals.totalTokens, 9741); // 9441 + 300
  assert.strictEqual(detail.totals.turnCount, 3);
  assert.strictEqual(detail.totals.exchangeCount, 2);
  assert.ok(Math.abs(detail.totals.costUsd - 0.85) < 1e-9);
});

maybe('readSessionDetail(opencode) filters by period (now in a later month → empty)', () => {
  const file = makeFixture();
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 's1', period: 'today',
    deps: { dbPaths: [file], sqlite, now: () => Date.UTC(2026, 6, 1, 12, 0, 0) }
  });
  assert.strictEqual(detail.found, true);
  assert.strictEqual(detail.exchanges.length, 0);
  assert.strictEqual(detail.totals.totalTokens, 0);
  assert.strictEqual(detail.totals.costUsd, 0);
});

maybe('readSessionDetail(opencode) returns not-found for an unknown session', () => {
  const file = makeFixture();
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 'nope', period: 'total',
    deps: { dbPaths: [file], sqlite }
  });
  assert.strictEqual(detail.found, false);
  assert.deepStrictEqual(detail.exchanges, []);
});
