'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeFixture } = require('../../scripts/benchmark-hub-resources');
const { aggregate, assertSameSummary, measure, run } = require('../../scripts/experiments/hub-resource-comparison/run-comparison');

test('experimental aggregation is a primitive projection, with no mutation of its shared fixture', () => {
  const input = makeFixture({ devices: 5, sessions: 3 });
  const before = structuredClone(input);
  const output = aggregate(input);
  assert.deepEqual(input, before);
  const total = input.reduce((sum, record) => sum + record.today.totalTokens, 0);
  assert.deepEqual(output.today, { totalTokens: total, costUsd: input.reduce((sum, record) => sum + record.today.costUsd, 0),
    clients: { codex: total }, models: { 'bench-model': total } });
  assert.deepEqual(output.today, output.month);
  assert.equal(output.today.sessions, undefined);
});

test('cross-runtime verification tolerates floating point order only, not different measurements', () => {
  const reference = aggregate(makeFixture({ devices: 5 }));
  const equivalent = structuredClone(reference);
  equivalent.today.costUsd += 1e-10;
  assert.doesNotThrow(() => assertSameSummary(reference, equivalent));
  equivalent.today.totalTokens++;
  assert.throws(() => assertSameSummary(reference, equivalent), /totals/);
  const wrongMap = structuredClone(reference);
  wrongMap.today.models['bench-model']++;
  assert.throws(() => assertSameSummary(reference, wrongMap), /maps/);
  const missing = structuredClone(reference);
  delete missing.today.costUsd;
  assert.throws(() => assertSameSummary(reference, missing), /totals/);
});

test('microbenchmark reports measured sample counts and rejects invalid CLI before creating output', () => {
  let calls = 0;
  const output = measure(3, () => ++calls);
  assert.equal(output.latencyMs.samples, 3);
  assert.equal(output.value, 3);
  for (const args of [['--devices=0'], ['--iterations=1001'], ['--sessions=201'], ['--foo=1'], ['--output']]) {
    assert.throws(() => run(args));
  }
});
