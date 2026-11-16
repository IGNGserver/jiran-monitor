#!/usr/bin/env node
'use strict';

// Build the platform-neutral source bundle for machines without a desktop GUI:
//   Jiran-Headless-<version>.tar.gz
//
// Dependencies are intentionally installed by the operator with
// `npm ci --omit=dev` on the target machine. That keeps Electron out of the
// headless install while npm still selects the target platform's tokscale
// package.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tar = require('tar');

const { parseProjectVersion } = require('../src/shared/versioning');

const root = path.resolve(__dirname, '..');
const requestedVersion = process.argv[2] || process.env.JIRAN_VERSION || process.env.TOKEN_MONITOR_VERSION || '';
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(requestedVersion || packageJson.version).replace(/^v/, '');
// Validated through the shared parser rather than a `-rev.N` regex: AGENTS.md
// documents the revision suffix as optional, so a plain SemVer release (0.46.0)
// is legal and the old pattern rejected it, failing the release's headless job.
if (!parseProjectVersion(version)) {
  throw new Error(`invalid headless package version: ${version}`);
}

const outDir = path.join(root, 'dist-headless');
const stageName = `jiran-headless-${version}`;
const stageDir = path.join(outDir, stageName);
const archivePath = path.join(outDir, `Jiran-Headless-${version}.tar.gz`);
const files = [
  ['src/agent', 'src/agent'],
  ['src/shared', 'src/shared'],
  ['.env.example', '.env.example'],
  ['docs/headless-agent.md', 'README.md'],
  ['LICENSE', 'LICENSE']
];

// The operator installs dependencies with `npm ci --omit=dev`, and shipping the
// root manifest made that pull 47.9 MB for a 25.0 MB closure (the widget, updater
// and Hub driver are all unreachable from src/agent/agent.js). Emit a manifest
// scoped to the real closure so a headless install stops paying ~22.8 MB per
// machine. `tokscale` must stay: its per-platform optional dependency is how npm
// selects the target machine's native binary.
const HEADLESS_DEPENDENCIES = ['chokidar', 'dotenv', 'semver', 'tokscale'];

function headlessPackageJson() {
  const dependencies = {};
  for (const name of HEADLESS_DEPENDENCIES) {
    const range = packageJson.dependencies?.[name];
    if (!range) throw new Error(`headless dependency ${name} is not declared in package.json`);
    dependencies[name] = range;
  }
  return {
    name: 'jiran-headless',
    version,
    private: true,
    description: 'Headless Jiran collector: scans local AI tool usage and posts it to a Docker Compose Hub.',
    main: 'src/agent/agent.js',
    bin: { 'jiran-agent': 'src/agent/agent.js' },
    scripts: {
      start: 'node --max-old-space-size=192 src/agent/agent.js',
      once: 'node --max-old-space-size=192 src/agent/agent.js --once'
    },
    dependencies,
    engines: packageJson.engines
  };
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
for (const [sourceRelative, destinationRelative] of files) {
  const source = path.join(root, sourceRelative);
  const destination = path.join(stageDir, destinationRelative);
  if (!fs.existsSync(source)) throw new Error(`missing ${sourceRelative}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

// Written after the copy loop: the root package.json is deliberately no longer
// part of `files`, so the bundle must not inherit the Electron entry point or the
// full dependency set.
fs.writeFileSync(
  path.join(stageDir, 'package.json'),
  `${JSON.stringify(headlessPackageJson(), null, 2)}\n`
);

// `npm ci` requires a lockfile. Generate it from the scoped manifest inside
// the staged bundle so the documented target install is reproducible and does
// not accidentally use the root Electron lockfile.
const npmArgs = [
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--omit=dev',
  '--no-audit',
  '--no-fund'
];
if (process.env.npm_execpath) {
  execFileSync(process.execPath, [process.env.npm_execpath, ...npmArgs], { cwd: stageDir, stdio: 'inherit' });
} else {
  execFileSync('npm', npmArgs, { cwd: stageDir, stdio: 'inherit' });
}
if (!fs.existsSync(path.join(stageDir, 'package-lock.json'))) {
  throw new Error('failed to create headless package-lock.json');
}

async function main() {
  await tar.c({ cwd: outDir, gzip: true, file: archivePath }, [stageName]);
  if (!fs.existsSync(archivePath)) throw new Error(`failed to create ${archivePath}`);
  console.log(archivePath);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
