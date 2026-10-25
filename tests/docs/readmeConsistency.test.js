'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MATRIX_FILE, matrixStats, summaryCounts } = require('./supportedTools');

const rootDir = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

// English plus Simplified Chinese, deliberately. Five locales used to be pinned row-for-row and
// sentence-for-sentence against each other, which is exactly how an upstream tagline survived
// every "rewrite the README" pass: rewording it failed five assertions at once, so the cheapest
// way back to green was to put the upstream sentence back. Coverage is now asserted against
// docs/supported-tools.md instead of against a copy of the prose, so a README can be reworded
// freely but cannot claim something the product does not do.
const readmeFiles = ['README.md', 'README.zh-CN.md'];

test('the README surface is English plus Simplified Chinese only', () => {
  const found = fs.readdirSync(rootDir).filter((name) => /^README.*\.md$/.test(name)).sort();
  assert.deepEqual(found, readmeFiles, 'a README locale appeared or vanished without updating this guard');
});

test('README summaries report the matrix counts', () => {
  const expected = matrixStats().counts;
  for (const file of readmeFiles) {
    assert.deepEqual(
      summaryCounts(read(file), file),
      expected,
      `${file}: the counts beside the ${MATRIX_FILE} link no longer match the matrix`
    );
  }
});

test('READMEs link the canonical documentation', () => {
  const links = [
    MATRIX_FILE,
    'docs/configuration.md',
    'docs/API.md',
    'docs/privacy.md',
    'docs/hub-compose.md',
    'docs/headless-agent.md',
    'docs/code-signing.md',
    'AGENTS.md',
    'LICENSE'
  ];
  for (const file of readmeFiles) {
    const text = read(file);
    for (const link of links) assert.ok(text.includes(link), `${file}: no link to ${link}`);
  }
});

test('READMEs disclose the WSL SQLite boundary', () => {
  // File-based WSL usage is merged automatically; a SQLite-backed client is not, and promising
  // otherwise is how a user ends up silently under-counted. Matched on unwrapped text because
  // the bullet runs across several source lines.
  for (const file of readmeFiles) {
    const flat = read(file).replace(/\s*\n\s*/g, ' ');
    const mentions = [...flat.matchAll(/WSL/g)];
    assert.ok(mentions.length > 0, `${file}: WSL is not documented at all`);
    const disclosed = mentions.some((match) => {
      const window = flat.slice(match.index, match.index + 400);
      return /SQLite/.test(window) && /docs\/wsl-sqlite-setup(?:\.zh-CN)?\.md/.test(window);
    });
    assert.ok(disclosed, `${file}: nothing states that a SQLite-backed WSL client needs the headless agent`);
  }
});

test('READMEs name the only supported Hub deployment', () => {
  for (const file of readmeFiles) {
    const text = read(file);
    assert.match(text, /docker-compose\.yml/, `${file}: must name the root Compose file as the Hub entry point`);
    assert.match(text, /docs\/hub-compose\.md/, `${file}: must link the canonical Compose guide`);
  }
});

test('READMEs say provider credentials belong to the Hub', () => {
  // The desktop client has no credential surface that talks to a provider, so a README that
  // implies otherwise documents a mode that was removed.
  const credentialLine = (text) => text
    .split('\n')
    .find((line) => /Hub/.test(line) && /(credential|凭据)/i.test(line));
  for (const file of readmeFiles) {
    assert.ok(credentialLine(read(file)), `${file}: nothing states that provider credentials live on the Hub`);
  }
});

test('READMEs carry the rename migration and the retired APT repository', () => {
  // APT is no longer a supported upgrade path: Linux users install the Releases .deb directly.
  // The READMEs must say so, or users will keep looking for a repository that no longer exists.
  for (const file of readmeFiles) {
    const text = read(file);
    assert.match(text, /Token Monitor/, `${file}: the former product name is not documented`);
    assert.match(text, /APT/, `${file}: the retired APT repository is not mentioned`);
    assert.match(text, /(retired|退役)/, `${file}: the reader is not told that APT was retired`);
    assert.match(text, /\.deb/, `${file}: the direct .deb download is not documented`);
  }
});

test('configuration reference env keys all exist in .env.example', () => {
  const envKeys = (text) => {
    const block = text.match(/```env\n([\s\S]*?)```/)?.[1] || '';
    return [...block.matchAll(/^(JIRAN_[A-Z0-9_]+)=/gm)].map((match) => match[1]);
  };
  const docKeys = envKeys(read('docs/configuration.md'));
  assert.ok(docKeys.length > 0, 'docs/configuration.md should list env keys');

  const exampleKeys = new Set(
    [...read('.env.example').matchAll(/^(JIRAN_[A-Z0-9_]+)=/gm)].map((match) => match[1])
  );
  for (const key of docKeys) assert.ok(exampleKeys.has(key), `${key} missing from .env.example`);
});

test('configuration reference sends provider accounts to the Hub', () => {
  const configuration = read('docs/configuration.md');
  // Quota credentials are Hub accounts; the doc must say so, must present them
  // under the Hub-web-only heading (the desktop page has no such section), and
  // must not present a device-local credentials section.
  assert.match(configuration, /Hub web dashboard only[\s\S]*\|\s*Accounts \/ Consumption\s*\|/, 'the accounts row should exist as a Hub-web section');
  assert.match(configuration, /Hub-owned quota accounts[^.]*OAuth/, 'accounts and their sign-in are Hub-owned');
  assert.match(configuration, /does not discover local developer-tool accounts/, 'the device must not claim to hold credentials');
  assert.doesNotMatch(configuration, /\*\*Window\*\* \|[^|]*tray mode/, 'the removed widget window settings must not be documented');
});

test('WSL SQLite guides keep English and Chinese entry points connected', () => {
  assert.match(read('docs/wsl-sqlite-setup.md'), /\[简体中文\]\(wsl-sqlite-setup\.zh-CN\.md\)/);
  assert.match(read('docs/wsl-sqlite-setup.zh-CN.md'), /\[English\]\(wsl-sqlite-setup\.md\)/);
});

test('WSL SQLite guides state and verify the Node.js prerequisite', () => {
  for (const file of ['docs/wsl-sqlite-setup.md', 'docs/wsl-sqlite-setup.zh-CN.md']) {
    const guide = read(file);
    assert.match(guide, /Node\.js 22\.13\.0/, file);
    assert.match(guide, /node --version\nnpm --version\n/, file);
  }
});
