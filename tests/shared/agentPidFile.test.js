'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { claimAgentPidFile, parseAgentPidRecord } = require('../../src/shared/agentPidFile');

function tempPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-agent-pid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = path.join(root, 'Jiran', 'agent.pid');
  const legacy = path.join(root, 'Token Monitor', 'agent.pid');
  return { current, legacy };
}

test('PID parser accepts legacy records and versioned ownership records', () => {
  assert.deepEqual(parseAgentPidRecord('4242\n'), { version: 0, pid: 4242, instanceId: null });
  assert.equal(parseAgentPidRecord('not-a-pid'), null);
  const parsed = parseAgentPidRecord(JSON.stringify({ version: 1, pid: 42, instanceId: 'owner', startedAt: 'now' }));
  assert.equal(parsed.pid, 42);
  assert.equal(parsed.instanceId, 'owner');
});

test('a live legacy agent blocks acquisition of the renamed PID file', (t) => {
  const { current, legacy } = tempPaths(t);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '4242');
  assert.throws(
    () => claimAgentPidFile({ pidPath: current, pidPaths: [current, legacy], pid: 100, isAlive: (pid) => pid === 4242 }),
    (error) => error.code === 'agent_already_running' && error.pid === 4242 && error.pidPath === legacy
  );
  assert.equal(fs.existsSync(current), false);
  assert.equal(fs.readFileSync(legacy, 'utf8'), '4242');
});

test('a live current owner cannot be overwritten by a daemon or one-shot claimant', (t) => {
  const { current } = tempPaths(t);
  const first = claimAgentPidFile({ pidPath: current, pid: 100, isAlive: (pid) => pid === 100 });
  const before = fs.readFileSync(current, 'utf8');
  for (const pid of [101, 102]) {
    assert.throws(
      () => claimAgentPidFile({ pidPath: current, pid, isAlive: (candidate) => candidate === 100 }),
      (error) => error.code === 'agent_already_running'
    );
    assert.equal(fs.readFileSync(current, 'utf8'), before);
  }
  assert.equal(first.release(), true);
  assert.equal(fs.existsSync(current), false);
});

test('a provably stale PID file is reclaimed and replaced atomically', (t) => {
  const { current } = tempPaths(t);
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.writeFileSync(current, '4242');
  const owner = claimAgentPidFile({ pidPath: current, pid: 100, isAlive: () => false, instanceId: 'new-owner' });
  assert.equal(parseAgentPidRecord(fs.readFileSync(current, 'utf8')).instanceId, 'new-owner');
  assert.equal(owner.release(), true);
});

test('malformed records fail closed instead of being overwritten', (t) => {
  const { current } = tempPaths(t);
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.writeFileSync(current, '{broken');
  assert.throws(
    () => claimAgentPidFile({ pidPath: current, pid: 100, isAlive: () => false }),
    (error) => error.code === 'agent_pid_invalid'
  );
  assert.equal(fs.readFileSync(current, 'utf8'), '{broken');
});

test('cleanup removes only the record owned by this process instance', (t) => {
  const { current } = tempPaths(t);
  const first = claimAgentPidFile({ pidPath: current, pid: 100, instanceId: 'first', isAlive: () => false });
  const replacement = `${JSON.stringify({ version: 1, pid: 101, instanceId: 'replacement' })}\n`;
  fs.writeFileSync(current, replacement);
  assert.equal(first.release(), false);
  assert.equal(fs.readFileSync(current, 'utf8'), replacement);
  assert.equal(first.release(), false);
});
