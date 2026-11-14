'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');
const { resolveElectronVersionOverride } = require('./electron-builder-version');
const { prepareLinuxPackageMetadata } = require('./prepare-linux-package-metadata');
const { releaseNotesPath } = require('./generate-release-notes');
const { adHocSignMacApp } = require('./macos-adhoc-sign');

// electron-builder downloads the framework selected by this top-level option.
// The release workflow sets the override only for the Linux artifact, so macOS
// and Windows continue to use the package.json Electron version.
const electronVersion = resolveElectronVersionOverride();

// The macOS Widget extension used to wrap this config through createBuilderConfig
// in scripts/macos-packaging.js. The desktop client is a normal app now, so the
// package.json build block is used directly.
const config = {
  ...packageJson.build,
  ...(electronVersion ? { electronVersion } : {})
};

// The embedded updater notes resolve to the *current version's* file, never to a shared
// template: reading one accumulated template is what made every latest*.yml ship the
// whole note history. A build for a version without notes fails with the fix, not later
// with stale bytes inside the installer.
const notesFile = releaseNotesPath(packageJson.version);
if (!fs.existsSync(path.join(__dirname, '..', notesFile))) {
  throw new Error(`${notesFile} is missing: write this release's 本次更新 there before building (see .github/RELEASE_NOTES_FORMAT.md)`);
}
config.releaseInfo = { ...config.releaseInfo, releaseNotesFile: notesFile };

const metainfoPath = prepareLinuxPackageMetadata({ version: packageJson.version });

// electron-builder's getSanitizedVersion() rewrites hyphens to tildes for the
// deb target (0.45.0-rev.24 -> 0.45.0~rev.24).  Debian's comparator sorts "~"
// before nothing, so that tilde version ranks *below* the bare base 0.45.0 and
// dpkg treats the upgrade as "already installed".  Feeding the raw version back
// through fpm keeps the hyphen so Debian parses upstream 0.45.0 / revision
// rev.24, which ranks above both the base and the previous rev.N.  FpmTarget
// appends options.fpm after its sanitized --version and fpm takes the last one.
config.deb = config.deb || {};
config.deb.fpm = [
  '--version',
  packageJson.version,
  `${metainfoPath}=/usr/share/metainfo/jiran.metainfo.xml`
];

// Keep only the Chromium locale packs the UI can actually select (renderer
// i18n.js exposes auto/en/zh-TW/zh-CN/ko/ja). electron-builder ships all 55,
// which is ~42 MB of a 139 MB AppImage for languages the app does not offer;
// Chromium falls back to en-US.pak for anything removed. Needs the en-US/en-GB
// pair plus the three CJK packs (zh-CN and zh-TW are distinct builds).
const KEPT_LOCALE_PACKS = new Set(['en-US', 'en-GB', 'zh-CN', 'zh-TW', 'ko', 'ja']);

function pruneChromiumLocales(context) {
  const fs = require('node:fs');
  const path = require('node:path');
  const resources = path.join(context.appOutDir, 'resources');
  const candidates = [
    path.join(context.appOutDir, 'locales'),
    path.join(resources, 'locales')
  ];
  let removed = 0;
  for (const dir of candidates) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.pak')) continue;
      if (KEPT_LOCALE_PACKS.has(entry.slice(0, -'.pak'.length))) continue;
      try { fs.rmSync(path.join(dir, entry)); removed += 1; } catch (_) { /* keep going */ }
    }
  }
  if (removed > 0) {
    console.log(`[electron-builder] pruned ${removed} unused Chromium locale packs`);
  }
}

config.afterPack = async (context) => {
  pruneChromiumLocales(context);
  // Ensure unsigned macOS builds still carry an embedded ad-hoc signature and
  // bundle identifier before .dmg/.zip packaging; macOS Local Network Privacy
  // and Apple Silicon Gatekeeper reject completely unsigned binaries.
  adHocSignMacApp(context, {
    defaultProductName: packageJson.build?.productName || packageJson.productName || 'Jiran'
  });
};

module.exports = config;
