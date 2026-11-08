'use strict';

// A release build downloads electron-builder's build tooling (the AppImage runtime,
// winCodeSign, NSIS) from GitHub Releases on every fresh runner. GitHub serves those
// as unauthenticated asset downloads and has repeated timeouts on them — its own
// status incident pyynvrm1vskw on 2026-08-11 was exactly "increase in timeouts for
// some unauthenticated users" — and a single failed fetch kills the job even though
// the cache it already filled survives. That cost v1.7.1 five whole runs.
//
// The retry is what turns a flapping CDN into a slow release instead of a failed one,
// so it has to survive future edits to these steps.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml');
const workflow = fs.readFileSync(WORKFLOW, 'utf8');

/** The text of one `- name: <name>` step, up to the next step in the same list. */
function stepBody(name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" must exist in release.yml`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n\s{6}- (?:name|uses|run):/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const RETRY_STEPS = [
  { step: 'Build platform artifacts', command: 'npm run ${{ matrix.dist_script }}' },
  { step: 'Build unpacked Windows application', command: 'npm run dist:win:dir' },
  { step: 'Package Windows application', command: 'npm run dist:win:prepackaged' }
];

test('every electron-builder step retries the GitHub asset download', () => {
  for (const { step, command } of RETRY_STEPS) {
    const body = stepBody(step);
    assert.ok(body.includes(command), `${step} must still run ${command}`);
    assert.match(
      body,
      /for (?:attempt in 1 2 3 4 5|\(\$attempt = 1; \$attempt -le 5; \$attempt\+\+\))/,
      `${step} must retry: these downloads are unauthenticated and time out`
    );
    assert.match(body, /::error::/, `${step} must still fail the job once the retries are spent`);
  }
});

test('a retry never deletes the input of the step it retries', () => {
  // dist:win:prepackaged consumes dist/win-unpacked produced by the step above it, so
  // clearing dist/ there would delete the very input the retry needs.
  const packaging = stepBody('Package Windows application');
  assert.doesNotMatch(packaging, /Remove-Item[^\n]*dist|rm -rf dist/);

  // The two steps that produce dist/ do clear it: a half-written installer must never
  // reach the verification steps that follow.
  assert.match(stepBody('Build platform artifacts'), /rm -rf dist/);
  assert.match(stepBody('Build unpacked Windows application'), /Remove-Item[^\n]*dist/);
});
