'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { androidVersionCode, verifyAndroidVersionCode } = require('../../scripts/verify-android-version-code');

test('Android release codes preserve the historical revision encoding', () => {
  assert.equal(androidVersionCode('1.5.0'), 105000000);
  assert.equal(androidVersionCode('0.47.0-rev.39'), 47000039);
  assert.ok(verifyAndroidVersionCode('1.5.0', '0.47.0-rev.39') > 47000039);
  assert.ok(verifyAndroidVersionCode('1.5.0-rev.1', '1.5.0') > androidVersionCode('1.5.0'));
});

test('Android release guards reject encoding collisions, overflow, equal versions and downgrades', () => {
  for (const version of ['1.100.0', '1.0.100', '1.0.0-rev.10000', '999.0.0', 'bad']) assert.throws(() => androidVersionCode(version));
  assert.throws(() => verifyAndroidVersionCode('1.5.0', '1.5.0-rev.1'), /increase/);
  assert.throws(() => verifyAndroidVersionCode('1.5.0', '1.5.0'), /increase/);
  assert.throws(() => verifyAndroidVersionCode('1.4.0', '1.5.0'), /increase/);
});