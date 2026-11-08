'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRequestRegistry } = require('../../src/electron/requestRegistry');

test('request cancellation is scoped to the owning renderer and always cleaned', () => {
  const registry = createRequestRegistry();
  const first = registry.begin('request-1', 10);
  const foreign = registry.begin('request-1', 11);
  assert.equal(registry.cancel('request-1', 999), false);
  assert.equal(first.signal.aborted, false);
  assert.equal(registry.cancel('request-1', 10), true);
  assert.equal(first.signal.aborted, true);
  assert.equal(first.finish(), true);
  assert.equal(first.finish(), false);
  assert.equal(registry.cancel('request-1', 10), false);
  assert.equal(foreign.finish(), true);
  assert.equal(registry.size, 0);
});

test('renderer destruction aborts every outstanding request it owns', () => {
  const registry = createRequestRegistry();
  const first = registry.begin('one', 10);
  const second = registry.begin('two', 10);
  const other = registry.begin('three', 11);
  assert.equal(registry.cancelOwner(10), 2);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  first.finish();
  second.finish();
  other.finish();
});
