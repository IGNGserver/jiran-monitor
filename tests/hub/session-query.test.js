'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { querySessions } = require('../../src/hub/session-query');

function session(client, sessionId, tokens, overrides = {}) {
  return {
    client, sessionId, totalTokens: tokens, costUsd: tokens / 100, messageCount: 1,
    models: { 'model-a': tokens }, projectId: 'project-1', projectLabel: 'Project One',
    lastUsedAt: '2026-11-07T01:00:00.000Z', ...overrides
  };
}

const stats = {
  devices: [
    {
      deviceId: 'device-a', hostname: 'Alpha', periods: { allTime: { sessions: {
        one: session('claude', 'one', 100),
        two: session('codex', 'two', 200, { models: { 'model-b': 200 }, projectId: 'project-2', projectLabel: 'Second' })
      } } }
    },
    {
      deviceId: 'device-b', hostname: 'Beta', periods: { allTime: { sessions: {
        three: session('claude', 'three', 100, { lastUsedAt: '2026-11-06T01:00:00.000Z' })
      } } }
    }
  ]
};

test('session search filters across device, project and model without request content', () => {
  const result = querySessions(stats, new URLSearchParams({ q: 'beta', period: 'allTime' }));
  assert.equal(result.total, 1);
  assert.equal(result.sessions[0].sessionId, 'three');
  assert.equal(querySessions(stats, new URLSearchParams({ model: 'model-b' })).sessions[0].sessionId, 'two');
  assert.equal(querySessions(stats, new URLSearchParams({ project: 'project-1' })).total, 2);
  assert.equal(querySessions(stats, new URLSearchParams({ project: 'device-a:project-1' })).total, 1);
  assert.equal(querySessions(stats, new URLSearchParams({ deviceId: 'device-a', client: 'claude' })).total, 1);
  assert.equal(JSON.stringify(result).includes('prompt'), false);
});

test('session cursors are bounded, stable and scoped to the query', () => {
  const first = querySessions(stats, new URLSearchParams({ sort: 'totalTokens', order: 'desc', limit: '2' }));
  assert.deepEqual(first.sessions.map((row) => row.sessionId), ['two', 'one']);
  assert.ok(first.nextCursor);
  const second = querySessions(stats, new URLSearchParams({ sort: 'totalTokens', order: 'desc', limit: '2', cursor: first.nextCursor }));
  assert.deepEqual(second.sessions.map((row) => row.sessionId), ['three']);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.sessions, ...second.sessions].map((row) => row.key)).size, 3);
  assert.throws(() => querySessions(stats, new URLSearchParams({ sort: 'totalTokens', order: 'asc', cursor: first.nextCursor })), /invalid_cursor/);
});

test('session query rejects unbounded or malformed input', () => {
  assert.throws(() => querySessions(stats, new URLSearchParams({ limit: '1000' })), /invalid_limit/);
  assert.throws(() => querySessions(stats, new URLSearchParams({ sort: 'payload' })), /invalid_sort/);
  assert.throws(() => querySessions(stats, new URLSearchParams({ period: 'yesterday' })), /invalid_period/);
  assert.throws(() => querySessions(stats, new URLSearchParams({ cursor: 'not-a-cursor' })), /invalid_cursor/);
});
