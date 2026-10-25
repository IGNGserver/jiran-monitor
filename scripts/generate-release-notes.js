'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPOSITORY = 'IGNGserver/jiran-monitor';
const DEFAULT_TEMPLATE = '.github/RELEASE_TEMPLATE.md';
const DEFAULT_NOTES_DIR = '.github/release-notes';
const DEFAULT_OUTPUT = 'release-body.md';
const HUB_IMAGE_NAME = 'jiran-hub';

const NOTES_START_MARKER = '<!-- app-update-notes:zh:start -->';
const NOTES_END_MARKER = '<!-- app-update-notes:zh:end -->';
const NOTES_PLACEHOLDER = '{{release_notes}}';
const DOWNLOADS_MARKER = '<!-- release-downloads -->';
const HUB_MARKER = '<!-- release-hub-image -->';

/**
 * The download list and the only place release artifact file names are spelled out.
 * `tests/shared/releaseArtifactNames.test.js` ties every row back to the
 * electron-builder `artifactName` patterns and to the release job's upload globs, so an
 * artifact that exists on the release page can no longer be missing from the list —
 * that is how the Android APK stayed off every release body.
 */
const RELEASE_ARTIFACTS = Object.freeze([
  { label: 'macOS Apple Silicon', file: 'Jiran-{version}-arm64.dmg', note: '' },
  { label: 'macOS Intel', file: 'Jiran-{version}-x64.dmg', note: '' },
  { label: 'Windows 安装版', file: 'Jiran-Setup-{version}.exe', note: '推荐' },
  { label: 'Windows 便携版', file: 'Jiran-{version}.exe', note: '免安装' },
  { label: 'Linux x64 AppImage', file: 'Jiran-{version}.AppImage', note: '应用内自动更新用这个' },
  { label: 'Linux x64 Debian 包', file: 'Jiran-{version}.deb', note: '直接安装；不再提供 APT 仓库' },
  { label: 'Android 手机端', file: 'Jiran-Android-{version}.apk', note: 'Hub 的读端，已用长期签名密钥签名' }
]);

function projectVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

/**
 * The per-version notes file is the single source of a release's 本次更新 block. One file
 * per version is what keeps the notes from accumulating: a release can only ever render
 * its own file, while one shared template block grew a new section on every tag and shipped
 * the whole history in every release body and in every `latest*.yml` releaseNotes field.
 */
function releaseNotesPath(version) {
  const cleanVersion = projectVersion(version);
  if (!cleanVersion) throw new Error('releaseNotesPath requires a version');
  return `${DEFAULT_NOTES_DIR}/${cleanVersion}.md`;
}

function assertExactlyOne(body, marker, description) {
  const count = body.split(marker).length - 1;
  if (count !== 1) {
    throw new Error(`expected exactly one ${description} marker (${marker}) in the release template, found ${count}`);
  }
}

function markedNotesSection(body, source) {
  assertExactlyOne(body, NOTES_START_MARKER, 'Chinese release-note start');
  assertExactlyOne(body, NOTES_END_MARKER, 'Chinese release-note end');
  const start = body.indexOf(NOTES_START_MARKER) + NOTES_START_MARKER.length;
  const end = body.indexOf(NOTES_END_MARKER, start);
  const section = body.slice(start, end).trim();
  // Prose is allowed (the whole point is a human-written Chinese summary), but a block
  // that still holds only headings means nobody wrote this release's notes.
  const content = section.split(/\r?\n/).filter((line) => line.trim() && !/^\s*#/.test(line));
  if (content.length === 0) {
    throw new Error(
      `the 本次更新 block in ${source || 'the release template'} is empty: write what this release changed before tagging`
    );
  }
  return section;
}

function artifactFile(artifact, version) {
  return artifact.file.replaceAll('{version}', version);
}

function releaseDownloadLines({ version, repository }) {
  const base = `https://github.com/${repository}/releases/download/v${version}`;
  return RELEASE_ARTIFACTS.map((artifact) => {
    const file = artifactFile(artifact, version);
    const note = artifact.note ? `（${artifact.note}）` : '';
    return `- **${artifact.label}** — [${file}](${base}/${file})${note}`;
  }).join('\n');
}

function hubDeploymentSection({ version, repositoryOwner, releaseType }) {
  const image = `ghcr.io/${String(repositoryOwner || '').toLowerCase()}/${HUB_IMAGE_NAME}`;
  const lines = [
    '---',
    '',
    '## Hub 镜像与 Compose',
    '',
    '```bash',
    `docker pull ${image}:${version}`
  ];
  if (releaseType === 'release') lines.push(`docker pull ${image}:latest`);
  lines.push('```', '');
  lines.push('> Hub 镜像已随项目改名迁移到 `jiran-hub`；`token-monitor-hub` 在过渡期内仍推送完全相同的标签，建议尽快更新 compose 中的镜像名。deb 包同样改名为 `jiran`；Linux 用户直接从 Release 下载 `.deb`，APT 仓库已退役。');
  if (releaseType === 'release') {
    lines.push(`Compose：在 \`.env\` 里设 \`JIRAN_VERSION=${version}\`（或 \`latest\`），然后 \`docker compose pull && docker compose up -d\`。`);
  } else {
    lines.push(`Compose：在 \`.env\` 里设 \`JIRAN_VERSION=${version}\`，然后 \`docker compose pull && docker compose up -d\`。本次是 prerelease，不会移动 \`latest\` 标签。`);
  }
  lines.push(
    '',
    `最小部署包是 Assets 里的 \`Jiran-Hub-Compose-${version}.zip\`；不带图形界面的采集器用 \`Jiran-Headless-${version}.tar.gz\`，解压后执行 \`npm ci --omit=dev\`。`
  );
  return lines.join('\n');
}

function substitutePlaceholders(text, values, source) {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`unknown release template placeholder: ${match}${source ? ` (in ${source})` : ''}`);
    }
    return values[key];
  });
}

function renderReleaseBody(template, {
  version,
  notes,
  repository = DEFAULT_REPOSITORY,
  repositoryOwner,
  releaseType = 'prerelease'
} = {}) {
  const cleanVersion = projectVersion(version);
  if (!cleanVersion) throw new Error('renderReleaseBody requires a version');
  if (typeof notes !== 'string' || !notes.trim()) {
    throw new Error(`renderReleaseBody requires the ${cleanVersion} release notes; write 本次更新 into ${releaseNotesPath(cleanVersion)}`);
  }

  // The template carries no notes of its own anymore. Hand-written content between markers
  // in the template is the accumulation surface this split removed, so it fails loudly.
  if (template.includes(NOTES_START_MARKER) || template.includes(NOTES_END_MARKER)) {
    throw new Error(
      `.github/RELEASE_TEMPLATE.md must not contain ${NOTES_START_MARKER}: per-version release notes live in ${DEFAULT_NOTES_DIR}/<version>.md`
    );
  }
  if (!template.includes(NOTES_PLACEHOLDER)) {
    throw new Error(`the release template is missing the ${NOTES_PLACEHOLDER} placeholder`);
  }

  const values = {
    version: cleanVersion,
    tag: `v${cleanVersion}`,
    repository,
    repositoryUrl: `https://github.com/${repository}`
  };

  // Render the notes first and validate them before they are spliced in, so a version token
  // can never leak into the section the app updater parses out of the release body.
  const notesBlock = notes.trim();
  for (const marker of [DOWNLOADS_MARKER, HUB_MARKER, NOTES_PLACEHOLDER]) {
    if (notesBlock.includes(marker)) {
      throw new Error(`the release notes must not contain ${marker}: structural markers belong to the template`);
    }
  }
  markedNotesSection(notesBlock, releaseNotesPath(cleanVersion));
  const substitutedNotes = substitutePlaceholders(notesBlock, values, releaseNotesPath(cleanVersion));
  markedNotesSection(substitutedNotes, releaseNotesPath(cleanVersion));

  const substituted = substitutePlaceholders(template, { ...values, release_notes: substitutedNotes });
  assertExactlyOne(substituted, DOWNLOADS_MARKER, 'download list');
  assertExactlyOne(substituted, HUB_MARKER, 'Hub deployment');

  const body = substituted
    .replace(DOWNLOADS_MARKER, releaseDownloadLines({ version: cleanVersion, repository }))
    .replace(HUB_MARKER, hubDeploymentSection({
      version: cleanVersion,
      repositoryOwner: repositoryOwner || repository.split('/')[0],
      releaseType
    }));

  if (/\{\{/.test(body)) {
    throw new Error('the rendered release body still contains an unresolved {{ placeholder');
  }
  markedNotesSection(body);
  return body;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function readReleaseNotes(version, { cwd = process.cwd(), notesPath } = {}) {
  const relativePath = notesPath || releaseNotesPath(version);
  const resolved = path.resolve(cwd, relativePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `${relativePath} is missing: write this release's 本次更新 there before tagging (see .github/RELEASE_NOTES_FORMAT.md)`
    );
  }
  return fs.readFileSync(resolved, 'utf8');
}

function generateReleaseBody({
  version,
  templatePath = DEFAULT_TEMPLATE,
  notesPath,
  outputPath = DEFAULT_OUTPUT,
  repository = DEFAULT_REPOSITORY,
  repositoryOwner,
  releaseType = 'prerelease',
  cwd = process.cwd()
} = {}) {
  const notes = readReleaseNotes(version, { cwd, notesPath });
  const template = fs.readFileSync(path.resolve(cwd, templatePath), 'utf8');
  const body = renderReleaseBody(template, {
    version,
    notes,
    repository,
    repositoryOwner,
    releaseType
  });
  const resolvedOutput = path.resolve(cwd, outputPath);
  fs.writeFileSync(resolvedOutput, `${body.trimEnd()}\n`, 'utf8');
  return { body, outputPath: resolvedOutput };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const repository = String(args.repository || DEFAULT_REPOSITORY).trim();
  const result = generateReleaseBody({
    version: args.version || '',
    templatePath: args.template || DEFAULT_TEMPLATE,
    notesPath: args.notes,
    outputPath: args.output || DEFAULT_OUTPUT,
    repository,
    repositoryOwner: args.owner,
    releaseType: args['release-type'] || 'prerelease'
  });
  console.log(`Rendered release body for ${projectVersion(args.version)} -> ${result.outputPath}`);
}

module.exports = {
  DEFAULT_NOTES_DIR,
  DEFAULT_REPOSITORY,
  DEFAULT_TEMPLATE,
  DOWNLOADS_MARKER,
  HUB_MARKER,
  NOTES_END_MARKER,
  NOTES_PLACEHOLDER,
  NOTES_START_MARKER,
  RELEASE_ARTIFACTS,
  artifactFile,
  generateReleaseBody,
  hubDeploymentSection,
  projectVersion,
  readReleaseNotes,
  releaseDownloadLines,
  releaseNotesPath,
  renderReleaseBody
};
