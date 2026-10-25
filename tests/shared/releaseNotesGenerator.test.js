'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  NOTES_PLACEHOLDER,
  RELEASE_ARTIFACTS,
  generateReleaseBody,
  hubDeploymentSection,
  readReleaseNotes,
  releaseDownloadLines,
  releaseNotesPath,
  renderReleaseBody
} = require('../../scripts/generate-release-notes');
const { extractReleaseNotes } = require('../../src/shared/appUpdater');

const root = path.join(__dirname, '..', '..');
const templatePath = path.join(root, '.github', 'RELEASE_TEMPLATE.md');
const workflowPath = path.join(root, '.github', 'workflows', 'release.yml');
const notesDir = path.join(root, '.github', 'release-notes');
const rootPackage = require('../../package.json');

const template = [
  '# Jiran {{tag}}',
  '',
  '## 本次更新',
  '',
  NOTES_PLACEHOLDER,
  '',
  '## 快捷下载',
  '',
  '<!-- release-downloads -->',
  '',
  '签名说明见 [README]({{repositoryUrl}}#readme)，包名 `Jiran-{{version}}.deb`。',
  '',
  '<!-- release-hub-image -->',
  ''
].join('\n');

const notes = [
  '<!-- app-update-notes:zh:start -->',
  '### 修复',
  '- 本版说明。',
  '<!-- app-update-notes:zh:end -->',
  ''
].join('\n');

function render(overrides = {}) {
  return renderReleaseBody(template, { version: '0.47.0', notes, ...overrides });
}

test('release body renders one Chinese section with version injected everywhere', () => {
  const body = render();

  assert.match(body, /^# Jiran v0\.47\.0$/m);
  assert.match(body, /<!-- app-update-notes:zh:start -->\n### 修复\n- 本版说明。\n<!-- app-update-notes:zh:end -->/);
  assert.match(body, /Jiran-0\.47\.0\.deb/);
  assert.match(body, /https:\/\/github\.com\/IGNGserver\/jiran-monitor#readme/);
  assert.doesNotMatch(body, /\{\{|\}\}/);
});

test('release body is Chinese-only for the app updater', () => {
  const parsed = extractReleaseNotes(render());
  assert.deepEqual(Object.keys(parsed), ['zh']);
  assert.deepEqual(parsed.zh.map((group) => group.title), ['修复']);
});

test('a release renders only its own notes, never an accumulated history', () => {
  // The regression this guards: every prep commit appended its section to one shared
  // template block, so each release body repeated every previous release.
  const olderNotes = notes.replace('本版说明。', '上一版的说明。');
  const body = render();
  assert.ok(!body.includes('上一版的说明。'));
  const olderBody = render({ notes: olderNotes });
  assert.ok(!olderBody.includes('本版说明。'));
});

test('download list is built from the artifact table and covers every published platform', () => {
  const lines = releaseDownloadLines({ version: '1.2.3', repository: 'acme/repo' }).split('\n');
  assert.equal(lines.length, RELEASE_ARTIFACTS.length);
  for (const line of lines) assert.match(line, /^- \*\*.+\*\* — \[.+\]\(https:\/\/github\.com\/acme\/repo\/releases\/download\/v1\.2\.3\/.+\)(（[^）]+）)?$/);
  assert.ok(lines.some((line) => line.includes('Jiran-Android-1.2.3.apk')), 'Android APK must never be missing from the list');
  assert.ok(lines.some((line) => line.includes('Jiran-1.2.3.deb')), 'The .deb must be listed for Linux users');
  assert.ok(lines.some((line) => line.includes('Jiran-Setup-1.2.3.exe')));
  assert.ok(lines.some((line) => line.includes('Jiran-1.2.3-arm64.dmg')));
  assert.ok(lines.some((line) => line.includes('Jiran-1.2.3.AppImage')));
  const labels = RELEASE_ARTIFACTS.map((artifact) => `- **${artifact.label}**`);
  assert.deepEqual(lines.map((line) => line.match(/^- \*\*.+?\*\*/)?.[0] ?? ''), labels);
});

test('hub section follows the release channel', () => {
  const pre = hubDeploymentSection({ version: '1.2.3-rev.4', repositoryOwner: 'Acme', releaseType: 'prerelease' });
  assert.match(pre, /docker pull ghcr\.io\/acme\/jiran-hub:1\.2\.3-rev\.4\n```/);
  assert.doesNotMatch(pre, /:latest/);
  assert.match(pre, /不会移动 `latest` 标签/);

  const formal = hubDeploymentSection({ version: '1.2.3', repositoryOwner: 'Acme', releaseType: 'release' });
  assert.match(formal, /docker pull ghcr\.io\/acme\/jiran-hub:latest/);
  assert.doesNotMatch(formal, /不会移动/);
});

test('renderer refuses a release body it cannot describe', () => {
  assert.throws(() => render({ notes: '<!-- app-update-notes:zh:start -->\n### 修复\n<!-- app-update-notes:zh:end -->\n' }), /本次更新 block .*is empty/);
  assert.throws(() => render({ notes: '' }), /write 本次更新/);
  assert.throws(() => render({ version: ' ' }), /requires a version/);
  assert.throws(() => renderReleaseBody(template.replace('{{tag}}', '{{unknown}}'), { version: '1.0.0', notes }), /unknown release template placeholder/);
  assert.throws(() => render({ notes: notes.replace('本版说明。', '版本 {{unknown}} 说明。') }), /unknown release template placeholder/);
  assert.throws(
    () => render({ notes: notes.replace('<!-- app-update-notes:zh:start -->', '') }),
    /exactly one Chinese release-note start marker/
  );
  assert.throws(
    () => renderReleaseBody(template.replace('<!-- release-downloads -->', ''), { version: '1.0.0', notes }),
    /exactly one download list marker/
  );
  assert.throws(
    () => renderReleaseBody(`${template}\n<!-- release-hub-image -->`, { version: '1.0.0', notes }),
    /exactly one Hub deployment marker/
  );
});

test('the template must not hand-write notes again', () => {
  assert.throws(
    () => renderReleaseBody(template.replace(NOTES_PLACEHOLDER, '<!-- app-update-notes:zh:start -->\n### 修复\n- 手写。\n<!-- app-update-notes:zh:end -->'), { version: '1.0.0', notes }),
    /must not contain <!-- app-update-notes:zh:start/
  );
  assert.throws(
    () => renderReleaseBody(template.replace(NOTES_PLACEHOLDER, '（空占位）'), { version: '1.0.0', notes }),
    /missing the \{\{release_notes\}\} placeholder/
  );
});

test('prose-only release notes are accepted', () => {
  const prose = notes.replace('### 修复\n- 本版说明。', '这一版只把深色主题换成纯黑底色，其余没有改动。');
  const body = render({ notes: prose });
  assert.match(body, /这一版只把深色主题换成纯黑底色/);
  // The app updater only parses `###` groups, so prose simply yields no in-app notes.
  assert.deepEqual(extractReleaseNotes(body), {});
});

test('notes resolve by version, including the v prefix on a tag', () => {
  assert.equal(releaseNotesPath('v0.47.0-rev.35'), '.github/release-notes/0.47.0-rev.35.md');
  assert.equal(releaseNotesPath('0.47.0'), '.github/release-notes/0.47.0.md');
  assert.throws(() => releaseNotesPath('  '), /requires a version/);
});

test('the committed template and current-version notes render the real release body', () => {
  const committedTemplate = fs.readFileSync(templatePath, 'utf8');
  assert.ok(committedTemplate.includes(NOTES_PLACEHOLDER));
  assert.ok(!committedTemplate.includes('<!-- app-update-notes:'));
  const body = renderReleaseBody(committedTemplate, {
    version: rootPackage.version,
    notes: readReleaseNotes(rootPackage.version, { cwd: root }),
    repositoryOwner: 'IGNGserver',
    releaseType: 'prerelease'
  });

  const parsed = extractReleaseNotes(body);
  assert.deepEqual(Object.keys(parsed), ['zh']);
  assert.ok(parsed.zh.length > 0);
  assert.ok(parsed.zh.every((group) => group.items.length > 0));
  assert.equal((body.match(/^## /gm) || []).length >= 2, true);
  for (const stale of ['<!-- app-update-notes:en:start -->', 'Full Changelog', '繁體中文', '한국어', '日本語', "## What's changed"]) {
    assert.ok(!body.includes(stale), `release body must not carry ${stale}`);
  }
});

test('every archived notes file is a valid single-version block', () => {
  const files = fs.readdirSync(notesDir).filter((name) => name.endsWith('.md'));
  assert.ok(files.includes(`${rootPackage.version}.md`), 'the current project version must have its own notes file');
  for (const name of files) {
    const content = fs.readFileSync(path.join(notesDir, name), 'utf8');
    const parsed = extractReleaseNotes(content);
    assert.deepEqual(Object.keys(parsed), ['zh'], `${name} must carry exactly the zh marked block`);
    assert.ok(parsed.zh.length > 0, `${name} has no release-note groups`);
    assert.ok(parsed.zh.every((group) => group.items.length > 0), `${name} has an empty release-note group`);
    assert.ok(!content.includes('{{'), `${name} must not carry template placeholders`);
    assert.ok(!content.includes('# Jiran'), `${name} holds only the 本次更新 block, not a whole body`);
  }
});

test('every listed download is uploaded by the release job', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const uploadBlock = workflow.split('uses: softprops/action-gh-release@v2')[1];
  assert.ok(uploadBlock, 'the release job must publish the release');
  const globs = uploadBlock
    .split('\n')
    .filter((line) => line.trim().startsWith('artifacts/'))
    .map((line) => line.trim().replace(/^artifacts\//, '').replace(/\*\*/g, '*'));
  assert.ok(globs.length > 0);

  const names = RELEASE_ARTIFACTS.map((artifact) => artifact.file.replaceAll('{version}', rootPackage.version));
  for (const name of names) {
    const matched = globs.some((pattern) => {
      const regex = new RegExp(`^${pattern.replace(/[.+]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return regex.test(name);
    });
    assert.ok(matched, `${name} is in the download list but not uploaded by the release job`);
  }
});

test('release workflow renders the body and adds no notes of its own', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /scripts\/generate-release-notes\.js/);
  assert.match(workflow, /--output release-body\.md/);
  assert.match(workflow, /--release-type "\$\{RELEASE_TYPE\}"/);
  assert.doesNotMatch(workflow, /cat \.github\/RELEASE_TEMPLATE\.md/);
  assert.doesNotMatch(workflow, /Hub Docker image/);
  assert.doesNotMatch(workflow, /github-generated-release-notes/);
});

test('generateReleaseBody writes the rendered body to disk', (t) => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'token-monitor-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = generateReleaseBody({
    version: rootPackage.version,
    templatePath,
    outputPath: path.join(dir, 'release-body.md'),
    cwd: root
  });
  const onDisk = fs.readFileSync(result.outputPath, 'utf8');
  assert.equal(onDisk.trimEnd(), result.body.trimEnd());
  assert.ok(onDisk.endsWith('\n'));

  assert.throws(
    () => generateReleaseBody({ version: '9.9.9', templatePath, cwd: root, outputPath: path.join(dir, 'missing.md') }),
    /\.github\/release-notes\/9\.9\.9\.md is missing/
  );
});
