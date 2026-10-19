'use strict';

// The per-file transcript cache must be invisible: every scan returns exactly
// what an uncached scan of the same tree returns — rows, their non-enumerable
// provenance/identity fields, and the diagnostics — including after a file
// grows, a file is removed, and across the separate today/month windows.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectQoderCnTranscriptRows } = require('../../src/shared/qoderCnUsage');

function line(timestamp, content, extra = {}) {
  return `${JSON.stringify({
    timestamp,
    sessionId: extra.sessionId,
    message: { role: 'assistant', content, model: extra.model || 'dfmodel', usage: extra.usage || { credits: 1 } },
    ...(extra.uuid ? { uuid: extra.uuid } : {})
  })}\n`;
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-transcript-cache-'));
  const root = path.join(home, '.qoder-cn', 'projects');
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const files = {
    a: write('alpha/s1.jsonl', line('2026-08-14T10:00:00Z', 'hello world', { uuid: 'a1' }) + line('2026-08-15T09:00:00Z', '你好世界', { uuid: 'a2', usage: { input_tokens: 40, output_tokens: 9, credits: 2 } })),
    b: write('alpha/s1/subagents/agent-1.jsonl', line('2026-08-15T11:00:00Z', 'sub agent work', { sessionId: 's1', uuid: 'b1' }) + 'not json\n'),
    c: write('beta/2026-08-15/s2.jsonl', line('2026-08-15T12:00:00Z', 'beta', { model: 'other-model', uuid: 'c1' }) + line('2026-08-15T12:05:00Z', 'more', { model: 'other-model' }))
  };
  return { home, root, files };
}

function view(result) {
  const rows = result.rows.map((row) => {
    const own = {};
    for (const key of Object.getOwnPropertyNames(row)) own[key] = row[key];
    return own;
  });
  return { rows, diagnostics: result.diagnostics };
}

function scan(home, extra = {}) {
  return view(collectQoderCnTranscriptRows({ homeDir: home, env: {}, timeZone: 'UTC', returnDiagnostics: true, ...extra }));
}

test('cached scans return exactly what an uncached scan returns', () => {
  const { home, files } = fixture();
  try {
    for (const sinceMs of [undefined, Date.parse('2026-08-15T00:00:00Z')]) {
      const extra = sinceMs === undefined ? {} : { sinceMs };
      const reference = scan(home, { ...extra, transcriptCache: false });
      assert.ok(reference.rows.length >= 3, 'the fixture produces rows');
      assert.deepEqual(scan(home, extra), reference, 'first (cold) scan');
      assert.deepEqual(scan(home, extra), reference, 'second (warm) scan');
    }

    // A running session appends: only that file is re-read, the answer still matches.
    fs.appendFileSync(files.c, line('2026-08-15T13:00:00Z', 'appended later', { model: 'other-model', uuid: 'c3' }));
    const grown = scan(home, { transcriptCache: false });
    assert.deepEqual(scan(home), grown, 'after an append');

    // A removed file drops out of the answer.
    fs.rmSync(files.b);
    const shrunk = scan(home, { transcriptCache: false });
    assert.deepEqual(scan(home), shrunk, 'after a removal');
    assert.notDeepEqual(shrunk.rows, grown.rows);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a warm scan does not read unchanged files again', () => {
  const { home } = fixture();
  const realOpen = fs.openSync;
  let opened = 0;
  fs.openSync = (...args) => { if (String(args[0]).endsWith('.jsonl')) opened += 1; return realOpen.apply(fs, args); };
  try {
    scan(home);
    const cold = opened;
    assert.ok(cold >= 3);
    scan(home);
    assert.equal(opened, cold, 'no transcript was opened on the warm scan');
    scan(home, { transcriptCache: false });
    assert.equal(opened, cold * 2, 'disabling the cache reads every file');
  } finally {
    fs.openSync = realOpen;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a scan cut short by its budget is not cached as complete', () => {
  const { home } = fixture();
  try {
    const reference = scan(home, { transcriptCache: false });
    let now = 0;
    // Each budget check advances the clock; a tiny duration budget stops the scan part-way.
    const truncated = scan(home, { maxDurationMs: 3, now: () => { now += 1; return now; } });
    assert.equal(truncated.diagnostics.truncated, true);
    assert.deepEqual(scan(home), reference, 'the next full scan is still exact');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
