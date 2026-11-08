'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MacUpdater } = require('electron-updater');

const rootPackage = require('../../package.json');
const {
  referencedArtifactNames,
  verifyUpdaterArtifactNames
} = require('../../scripts/verify-updater-artifact-names');
const { mergeMacUpdaterMetadata } = require('../../scripts/merge-mac-updater-metadata');
const { resolveElectronVersionOverride } = require('../../scripts/electron-builder-version');
const { extractReleaseNotes } = require('../../src/shared/appUpdater');
const { RELEASE_ARTIFACTS, readReleaseNotes, renderReleaseBody, releaseNotesPath } = require('../../scripts/generate-release-notes');
const { MAC_APP_MIN_DARWIN_VERSION } = require('../../src/shared/macSystemRequirements');

function macUpdaterMetadata(version, arch) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: Jiran-${version}-${arch}.zip`,
    `    sha512: ${arch}-zip-hash`,
    '    size: 100',
    `  - url: Jiran-${version}-${arch}.dmg`,
    `    sha512: ${arch}-dmg-hash`,
    '    size: 200',
    `path: Jiran-${version}-${arch}.zip`,
    `sha512: ${arch}-zip-hash`,
    "releaseDate: '2026-07-21T00:00:00.000Z'",
    'releaseNotes: |',
    '  <!-- app-update-notes:en:start -->',
    '  ### Fixed',
    `  - ${arch} release notes survive metadata processing.`,
    '  <!-- app-update-notes:en:end -->',
    ''
  ].join('\n');
}

test('release artifact templates use GitHub-safe names', () => {
  const patterns = [
    rootPackage.build.mac.artifactName,
    rootPackage.build.linux.artifactName,
    rootPackage.build.nsis.artifactName,
    rootPackage.build.portable.artifactName
  ];
  assert.deepEqual(patterns, [
    'Jiran-${version}-${arch}.${ext}',
    'Jiran-${version}.${ext}',
    'Jiran-Setup-${version}.${ext}',
    'Jiran-${version}.${ext}'
  ]);
  for (const pattern of patterns) assert.doesNotMatch(pattern, /\s/);
});

test('updater metadata embeds the current version Chinese release-note section', () => {
  // One file per version is what keeps `latest*.yml` from shipping an accumulated
  // 本次更新 block; package.json must not pin a shared notes template again.
  assert.equal(rootPackage.build.releaseInfo, undefined, 'package.json must not hard-code a shared releaseNotesFile');
  const projectRoot = path.join(__dirname, '..', '..');
  const configNotesFile = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(require('./scripts/electron-builder.config.js').releaseInfo.releaseNotesFile)"],
    { cwd: projectRoot }
  ).toString();
  assert.equal(configNotesFile, releaseNotesPath(rootPackage.version));
  const notesFile = fs.readFileSync(path.join(projectRoot, configNotesFile), 'utf8');
  const notes = extractReleaseNotes(notesFile);
  // The release body is Chinese-only by project decision; `.github/RELEASE_NOTES_FORMAT.md`
  // is the shape, and a second language here would silently become a stale one.
  assert.deepEqual(Object.keys(notes), ['zh']);
  assert.ok(notes.zh.length > 0, 'zh has no release-note groups');
  assert.ok(notes.zh.every((group) => group.items.length > 0), 'zh has an empty release-note group');
  assert.doesNotMatch(notesFile, /releases\/download\//, 'download links are rendered from RELEASE_ARTIFACTS; the notes must not hand-write them');
});

test('download list names match the artifacts the build actually produces', () => {
  const version = rootPackage.version;
  const expand = (pattern, ext, arch) => pattern
    .replaceAll('${version}', version)
    .replaceAll('${arch}', arch || '')
    .replaceAll('${ext}', ext);
  const builtNames = new Set([
    expand(rootPackage.build.mac.artifactName, 'dmg', 'arm64'),
    expand(rootPackage.build.mac.artifactName, 'dmg', 'x64'),
    expand(rootPackage.build.linux.artifactName, 'AppImage'),
    expand(rootPackage.build.linux.artifactName, 'deb'),
    expand(rootPackage.build.nsis.artifactName, 'exe'),
    expand(rootPackage.build.portable.artifactName, 'exe'),
    `Jiran-Android-${version}.apk`
  ]);

  const listed = RELEASE_ARTIFACTS.map((artifact) => artifact.file.replaceAll('{version}', version));
  assert.equal(listed.length, builtNames.size, 'every built artifact should be downloadable from the release body');
  for (const name of listed) {
    assert.ok(builtNames.has(name), `${name} is offered for download but no build target produces it`);
  }

  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /Jiran-Android-\$\{version\}\.apk/);
});

test('mac release scripts build native Apple Silicon and Intel artifacts', () => {
  assert.deepEqual(rootPackage.build.mac.target, ['dmg', 'zip']);
  assert.match(rootPackage.scripts['dist:mac'], /--arm64/);
  assert.match(rootPackage.scripts['dist:mac:x64'], /--x64/);

  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /os: macos-15\s+target: mac\s+arch: arm64/);
  assert.match(workflow, /os: macos-15-intel\s+target: mac\s+arch: x64/);
  assert.match(workflow, /artifacts\/jiran-mac-arm64\/latest-mac\.yml \\\s+artifacts\/jiran-mac-x64\/latest-mac\.yml/);
  assert.doesNotMatch(workflow, /latest-mac-(?:arm64|x64)\.yml/);

  const releaseTemplate = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'RELEASE_TEMPLATE.md'), 'utf8');
  const body = renderReleaseBody(releaseTemplate, {
    version: rootPackage.version,
    notes: readReleaseNotes(rootPackage.version, { cwd: path.join(__dirname, '..', '..') })
  });
  const intelBullets = body.split('\n').filter((line) => line.startsWith('- **macOS Intel**'));
  const intelDmg = `Jiran-${rootPackage.version}-x64.dmg`;
  assert.equal(intelBullets.length, 1);
  assert.equal(intelBullets[0].split(intelDmg).length, 3);
  assert.ok(intelBullets[0].includes(`/download/v${rootPackage.version}/`));
  // GitHub's generated changelog was English PR prose, and no workflow step ever filled it
  // in, so the block shipped empty; the version diff already lives on the tag page.
  assert.doesNotMatch(body, /Full Changelog|github-generated-release-notes/);
  assert.doesNotMatch(body, /繁體中文|한국어|日本語/);
});

test('release workflow pins Electron only for the Linux artifact', () => {
  assert.equal(rootPackage.devDependencies.electron, '43.8.7');
  assert.match(
    rootPackage.scripts['dist:linux'],
    /^electron-builder --config scripts\/electron-builder\.config\.js --linux --x64 --publish never$/
  );
  assert.equal(resolveElectronVersionOverride({}), undefined);
  assert.equal(
    resolveElectronVersionOverride({
      TOKEN_MONITOR_ELECTRON_TARGET: 'linux',
      TOKEN_MONITOR_LINUX_ELECTRON_VERSION: '43.2.0'
    }),
    '43.2.0'
  );
  assert.throws(
    () => resolveElectronVersionOverride({ TOKEN_MONITOR_LINUX_ELECTRON_VERSION: '43.2.0' }),
    /only valid for a Linux build/
  );
  const defaultConfig = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(String(require('./scripts/electron-builder.config.js').electronVersion || ''))"],
    {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        TOKEN_MONITOR_ELECTRON_TARGET: '',
        TOKEN_MONITOR_LINUX_ELECTRON_VERSION: ''
      }
    }
  ).toString();
  assert.equal(defaultConfig, '');
  const configWithLinuxOverride = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(String(require('./scripts/electron-builder.config.js').electronVersion || ''))"],
    {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        TOKEN_MONITOR_ELECTRON_TARGET: 'linux',
        TOKEN_MONITOR_LINUX_ELECTRON_VERSION: '43.2.0'
      }
    }
  ).toString();
  assert.equal(configWithLinuxOverride, '43.2.0');
  assert.throws(
    () => resolveElectronVersionOverride({
      TOKEN_MONITOR_ELECTRON_TARGET: 'linux',
      TOKEN_MONITOR_LINUX_ELECTRON_VERSION: '43.2'
    }),
    /must be an exact semver version/
  );

  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /if: matrix\.target == 'linux'\s+run: \|\s+echo "TOKEN_MONITOR_ELECTRON_TARGET=linux" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /echo "TOKEN_MONITOR_LINUX_ELECTRON_VERSION=43\.2\.0" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /- name: Verify Electron packaging version\s+run: \|\s+node -e /);
  assert.match(workflow, /require\('\.\/scripts\/electron-builder\.config\.js'\)/);
  assert.match(workflow, /npm run \$\{\{ matrix\.dist_script \}\}/);
});

test('release icons use source assets without the legacy generator', () => {
  const projectRoot = path.join(__dirname, '..', '..');
  const iconSources = new Set([
    rootPackage.build.mac.icon,
    rootPackage.build.win.icon,
    rootPackage.build.linux.icon
  ]);

  for (const iconSource of iconSources) {
    assert.ok(fs.existsSync(path.join(projectRoot, iconSource)), `missing release icon source: ${iconSource}`);
  }
  assert.equal(rootPackage.scripts.icons, undefined);
  assert.equal(rootPackage.devDependencies['electron-icon-builder'], undefined);
});

test('extracts updater artifact names from url and path fields', () => {
  const names = referencedArtifactNames([
    'files:',
    '  - url: Jiran-0.25.0-arm64.zip',
    'path: "Jiran-0.25.0-arm64.zip"',
    "  - url: 'https://example.com/Jiran-0.25.0-arm64.dmg'"
  ].join('\n'));
  assert.deepEqual(names, [
    'Jiran-0.25.0-arm64.zip',
    'Jiran-0.25.0-arm64.dmg'
  ]);
});

test('fails when updater metadata references an asset that will not be uploaded', (t) => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-release-'));
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(distDir, 'latest-mac.yml'), [
    'version: 0.25.0',
    'files:',
    '  - url: Jiran-0.25.0-arm64.zip',
    'path: Jiran-0.25.0-arm64.zip'
  ].join('\n'));

  assert.throws(
    () => verifyUpdaterArtifactNames(distDir),
    /latest-mac\.yml -> Jiran-0\.25\.0-arm64\.zip/
  );

  fs.writeFileSync(path.join(distDir, 'Jiran-0.25.0-arm64.zip'), 'artifact');
  assert.deepEqual(verifyUpdaterArtifactNames(distDir), {
    metadataFiles: ['latest-mac.yml']
  });
});

test('merges arm64 and x64 mac updater files into one architecture-aware feed', (t) => {
  const version = '0.33.0';
  const merged = mergeMacUpdaterMetadata(
    macUpdaterMetadata(version, 'arm64'),
    macUpdaterMetadata(version, 'x64')
  );
  assert.deepEqual(referencedArtifactNames(merged), [
    `Jiran-${version}-arm64.zip`,
    `Jiran-${version}-arm64.dmg`,
    `Jiran-${version}-x64.zip`,
    `Jiran-${version}-x64.dmg`
  ]);
  assert.match(merged, new RegExp(`^path: Jiran-${version}-arm64\\.zip$`, 'm'));
  assert.match(merged, new RegExp(`^minimumSystemVersion: ${MAC_APP_MIN_DARWIN_VERSION.replaceAll('.', '\\.')}$`, 'm'));
  assert.equal((merged.match(/^minimumSystemVersion:/gm) || []).length, 1);
  assert.match(merged, /arm64 release notes survive metadata processing/);
  assert.doesNotMatch(merged, /x64 release notes survive metadata processing/);

  const files = referencedArtifactNames(merged).map((fileName) => ({
    url: new URL(`https://release.invalid/${fileName}`),
    info: { url: fileName }
  }));
  assert.deepEqual(
    MacUpdater.filterFilesForArch(files, true).map((file) => path.basename(file.url.pathname)),
    [`Jiran-${version}-arm64.zip`, `Jiran-${version}-arm64.dmg`]
  );
  assert.deepEqual(
    MacUpdater.filterFilesForArch(files, false).map((file) => path.basename(file.url.pathname)),
    [`Jiran-${version}-x64.zip`, `Jiran-${version}-x64.dmg`]
  );

  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiran-mac-release-'));
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(distDir, 'latest-mac.yml'), merged);
  for (const fileName of referencedArtifactNames(merged)) {
    fs.writeFileSync(path.join(distDir, fileName), 'artifact');
  }
  assert.deepEqual(verifyUpdaterArtifactNames(distDir), {
    metadataFiles: ['latest-mac.yml']
  });
});

test('rejects mismatched or mislabelled mac updater metadata', () => {
  assert.throws(
    () => mergeMacUpdaterMetadata(
      macUpdaterMetadata('0.33.0', 'arm64'),
      macUpdaterMetadata('0.33.1', 'x64')
    ),
    /versions differ/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      macUpdaterMetadata('0.33.0', 'x64'),
      macUpdaterMetadata('0.33.0', 'arm64')
    ),
    /expected only arm64 artifacts/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      macUpdaterMetadata('0.33.0', 'arm64').replace(
        'files:',
        'minimumSystemVersion: 23.0.0\nfiles:'
      ),
      macUpdaterMetadata('0.33.0', 'x64')
    ),
    /does not match release policy/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      macUpdaterMetadata('0.33.0', 'arm64').replace(
        'files:',
        'minimumSystemVersion:\nfiles:'
      ),
      macUpdaterMetadata('0.33.0', 'x64')
    ),
    /empty top-level minimumSystemVersion/
  );
});

test('rejects stale or missing top-level mac updater paths', () => {
  const version = '0.33.0';
  const arm64Metadata = macUpdaterMetadata(version, 'arm64');
  const x64Metadata = macUpdaterMetadata(version, 'x64');

  assert.throws(
    () => mergeMacUpdaterMetadata(
      arm64Metadata.replace(
        `path: Jiran-${version}-arm64.zip`,
        `path: Jiran-${version}-x64.zip`
      ),
      x64Metadata
    ),
    /arm64 metadata path Jiran-0\.33\.0-x64\.zip does not reference an arm64 artifact/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      arm64Metadata.replace(
        `path: Jiran-${version}-arm64.zip`,
        `path: Other-Monitor-${version}-arm64.zip`
      ),
      x64Metadata
    ),
    /arm64 metadata path Other-Monitor-0\.33\.0-arm64\.zip is not present in its files list/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      arm64Metadata.replace(
        `path: Jiran-${version}-arm64.zip`,
        `path: Jiran-${version}-arm64.dmg`
      ),
      x64Metadata
    ),
    /arm64 metadata path Jiran-0\.33\.0-arm64\.dmg is not a zip artifact/
  );
  assert.throws(
    () => mergeMacUpdaterMetadata(
      arm64Metadata.replace(`path: Jiran-${version}-arm64.zip\n`, ''),
      x64Metadata
    ),
    /arm64 metadata must have exactly one top-level path/
  );
});
