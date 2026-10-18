'use strict';

// The vendored Fluent bundle must not carry fast-element 3.0.3's per-element
// definition subscription: it retained every Fluent element ever created, which
// is how the desktop renderer grew without bound against a live Hub.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PATCHES, patchFluentBundle } = require('../../scripts/fluentBundlePatches');

const root = path.join(__dirname, '..', '..');
const vendored = fs.readFileSync(path.join(root, 'src', 'shared-ui', 'vendor', 'fluent.js'), 'utf8');
const upstreamPath = path.join(root, 'node_modules', '@fluentui', 'web-components', 'dist', 'web-components-all.min.js');

test('the vendored bundle carries the element-controller leak fix', () => {
  for (const patch of PATCHES) {
    assert.equal(vendored.includes(patch.leaking), false, `${patch.id}: leaking code is gone`);
    assert.equal(vendored.split(patch.fixed).length - 1, 1, `${patch.id}: fixed code is present once`);
  }
  // No per-instance subscription to the definition's shadowOptions survives.
  assert.doesNotMatch(vendored, /subscribe\(\{handleChange:\(\)=>\{Ge\.forCustomElement\(e,!0\),e\.\$fastController\.connect\(\)\}\},"shadowOptions"\)/);
});

test('the vendored bundle is exactly the pinned upstream dist with the patches applied', { skip: !fs.existsSync(upstreamPath) }, () => {
  const { text } = patchFluentBundle(fs.readFileSync(upstreamPath, 'utf8'));
  assert.equal(text, vendored, 'run `npm run update:fluent-assets` instead of editing fluent.js by hand');
});

test('patching is idempotent and refuses a bundle whose shape it does not recognise', () => {
  const once = patchFluentBundle(`a;${PATCHES[0].leaking};b`);
  assert.deepEqual(once.applied, [PATCHES[0].id]);
  const twice = patchFluentBundle(once.text);
  assert.deepEqual(twice.applied, []);
  assert.equal(twice.text, once.text);
  assert.throws(() => patchFluentBundle('a bundle with neither shape'), /expected one match, found 0/);
});
