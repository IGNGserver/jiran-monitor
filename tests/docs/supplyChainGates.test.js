'use strict';

// Supply-chain and release gates are easy to weaken without noticing: an Action
// reference drifts back to a mutable tag, a validation step regains a
// PR-only condition, or the container loses its least-privilege shape. These
// assertions pin the shape, not the wording.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const workflows = fs.readdirSync(path.join(root, '.github', 'workflows'))
  .filter((name) => name.endsWith('.yml'));

test('every workflow Action is pinned to an immutable commit', () => {
  for (const name of workflows) {
    const text = read(path.join('.github', 'workflows', name));
    for (const line of text.split('\n')) {
      const match = /^\s*(?:- )?uses: (\S+)/.exec(line);
      if (!match) continue;
      const target = match[1];
      if (target.startsWith('./')) continue;
      assert.match(
        target,
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/,
        `${name}: "${target}" must pin a full commit SHA (with a "# vN" comment)`
      );
      assert.match(line, /# v\d+/, `${name}: pinned reference "${target}" must name its tag in a comment`);
    }
  }
});

test('the Hub image pins its base image and runs unprivileged', () => {
  const dockerfile = read('Dockerfile');
  const fromLines = dockerfile.split('\n').filter((line) => /^FROM /.test(line));
  assert.ok(fromLines.length >= 2, 'expected multiple build stages');
  for (const line of fromLines) {
    assert.match(line, /@sha256:[0-9a-f]{64}/, `base image must be digest-pinned: ${line}`);
  }
  assert.match(dockerfile, /^USER node$/m, 'the runtime stage must drop to the node user');
});

for (const name of ['docker-compose.yml', 'docker-compose.external-db.yml']) {
  test(`${name} keeps the Hub container unprivileged`, () => {
    const text = read(name);
    assert.match(text, /cap_drop:\n\s+- ALL/, `${name}: cap_drop ALL`);
    assert.match(text, /read_only: true/, `${name}: read-only root filesystem`);
    assert.match(text, /tmpfs:\n\s+- \/tmp/, `${name}: /tmp tmpfs`);
    assert.match(text, /no-new-privileges:true/, `${name}: no-new-privileges`);
  });
}

test('container hardening is documented for operators', () => {
  const guide = read('docs/hub-compose.md');
  assert.match(guide, /## Container runtime/);
  assert.ok(guide.includes('uid 1000'));
  assert.ok(guide.includes('no-new-privileges'));
});

test('every deploy path runs the browser suite first', () => {
  const website = read(path.join('.github', 'workflows', 'website.yml'));
  const steps = website.split(/\n\s*- name: /);
  const e2e = steps.find((step) => step.startsWith('End-to-end tests'));
  assert.ok(e2e, 'website workflow must keep an e2e step');
  assert.equal(/\n\s*if:/.test(e2e), false, 'the e2e step must not be conditional: it gates deploys too');
  assert.ok(
    website.indexOf('- name: End-to-end tests') < website.indexOf('- name: Deploy to Cloudflare Pages'),
    'tests must run before the deploy step'
  );
});

test('the browser bundle is validated on main as well as on pull requests', () => {
  const ci = read(path.join('.github', 'workflows', 'ci.yml'));
  const steps = ci.split(/\n\s*- name: /);
  for (const name of ['Build browser assets and validate the offline graph', 'Validate production web image']) {
    const step = steps.find((entry) => entry.startsWith(name));
    assert.ok(step, `missing CI step: ${name}`);
    assert.equal(
      step.includes("github.event_name == 'pull_request'"),
      false,
      `${name} must also run on main, not only for pull requests`
    );
  }
});

test('MySQL and Compose+MySQL run outside the pull-request path', () => {
  const ci = read(path.join('.github', 'workflows', 'ci.yml'));
  for (const job of ['hub-integration:', 'compose-smoke:', 'android:']) {
    const index = ci.indexOf(`\n  ${job}`);
    assert.ok(index >= 0, `missing CI job: ${job}`);
    const block = ci.slice(index, ci.indexOf('\n  # ', index + 1) === -1 ? undefined : ci.indexOf('\n  # ', index + 1));
    assert.equal(
      /\n\s+if: github\.event_name == 'pull_request'/.test(block),
      false,
      `${job} must run on main too`
    );
  }
  const release = read(path.join('.github', 'workflows', 'release.yml'));
  assert.match(release, /\n\s+compose-smoke:/, 'a release must start the shipped stack once');
  assert.match(release, /needs: \[build, android, headless, hub-image, compose-smoke\]/);
});

test('the published image records the commit it was built from', () => {
  const release = read(path.join('.github', 'workflows', 'release.yml'));
  assert.match(release, /echo "revision=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"/);
  assert.match(release, /org\.opencontainers\.image\.revision=\$\{\{ steps\.meta\.outputs\.revision \}\}/);
  assert.equal(
    release.includes('org.opencontainers.image.revision=${{ github.sha }}'),
    false,
    'the label must follow the checked-out ref, not the event sha'
  );
});

test('CodeQL scans the Android client', () => {
  const codeql = read(path.join('.github', 'workflows', 'codeql.yml'));
  assert.match(codeql, /- language: java-kotlin\n\s+build-mode: manual/);
  assert.match(codeql, /:app:compileDebugKotlin/);
});
