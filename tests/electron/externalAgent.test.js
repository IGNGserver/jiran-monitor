'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { externalAgentActive } = require('../../src/electron/collectorHost');

function fsWith(records) {
  return {
    readFileSync(filePath) {
      if (!Object.hasOwn(records, filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return records[filePath];
    }
  };
}

test('desktop backoff recognizes versioned and legacy live agent records', () => {
  const records = {
    current: JSON.stringify({ version: 1, pid: 100, instanceId: 'current' }),
    legacy: '200\n'
  };
  const live = new Set([200]);
  assert.equal(externalAgentActive(['current', 'legacy'], fsWith(records), (pid) => {
    if (!live.has(pid)) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  }), true);
});

test('desktop backoff ignores stale, malformed and own records', () => {
  const records = {
    malformed: '{broken',
    own: String(process.pid),
    stale: JSON.stringify({ version: 1, pid: 100, instanceId: 'stale' })
  };
  assert.equal(externalAgentActive(['malformed', 'own', 'stale'], fsWith(records), () => {
    throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  }), false);
});

test('desktop backoff treats an existing but unsignalable process as live', () => {
  const records = { current: '100' };
  assert.equal(externalAgentActive(['current'], fsWith(records), () => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  }), true);
});
