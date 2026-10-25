'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeReleaseDate,
  prepareLinuxPackageMetadata
} = require('../../scripts/prepare-linux-package-metadata');

test('Linux AppStream metadata renders the package version and release date', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-metainfo-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const templatePath = path.join(directory, 'template.xml');
  const outputPath = path.join(directory, 'nested', 'jiran.metainfo.xml');
  fs.writeFileSync(templatePath, '<component><release version="__VERSION__" date="__RELEASE_DATE__" /></component>\n');

  const result = prepareLinuxPackageMetadata({
    version: '0.45.0-rev.28',
    releaseDate: '2026-09-12',
    templatePath,
    outputPath
  });

  assert.equal(result, outputPath);
  assert.equal(
    fs.readFileSync(outputPath, 'utf8'),
    '<component><release version="0.45.0-rev.28" date="2026-09-12" /></component>\n'
  );
});

test('Linux AppStream template declares an App Center launchable', () => {
  const templatePath = path.join(__dirname, '..', '..', 'packaging', 'linux', 'jiran.metainfo.xml.in');
  const template = fs.readFileSync(templatePath, 'utf8');
  assert.match(template, /<id>com\.igng\.tokenmonitor\.desktop<\/id>/);
  assert.match(template, /<launchable type="desktop-id">jiran\.desktop<\/launchable>/);
  assert.match(template, /<category>Development<\/category>/);
  assert.match(template, /<provides>\s*<binary>jiran<\/binary>/);
});

test('Linux package metadata rejects malformed release dates', () => {
  assert.equal(normalizeReleaseDate('2026-09-12'), '2026-09-12');
  assert.throws(() => normalizeReleaseDate('2026/09/12'), /YYYY-MM-DD/);
});

test('Linux release workflow verifies the built Debian package', () => {
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /name: Verify Debian package metadata and version/);
  assert.match(workflow, /npm run verify:deb -- "\$deb_path" --version "\$version"/);
});

test('release pipeline no longer publishes an APT repository or GitHub Pages site', () => {
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.doesNotMatch(workflow, /build-apt-repository/);
  assert.doesNotMatch(workflow, /deploy-pages/);
  assert.doesNotMatch(workflow, /_site\/apt/);
});
