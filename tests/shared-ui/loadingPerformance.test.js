'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

test('loading marks are an allowlisted, one-shot local diagnostic', async () => {
  const { markLoadingStage } = await import(pathToFileURL(path.resolve(__dirname, '../../src/shared-ui/core/loadingPerformance.js')));
  const marks = [];
  const clock = { mark: (name) => marks.push(name) };
  markLoadingStage('shell', clock);
  markLoadingStage('shell', clock);
  markLoadingStage('secret-or-url', clock);
  assert.deepEqual(marks, ['jiran:loading:shell']);
});
