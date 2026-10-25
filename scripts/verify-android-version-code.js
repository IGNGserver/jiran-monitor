'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseProjectVersion, compareProjectVersions } = require('../src/shared/versioning');

function androidVersionCode(value) {
  const parsed = parseProjectVersion(value);
  if (!parsed || parsed.minor > 99 || parsed.patch > 99 || (parsed.revision || 0) > 9999) {
    throw new Error(`Android version components exceed their encoding slots: ${value}`);
  }
  const code = (parsed.major * 10000 + parsed.minor * 100 + parsed.patch) * 10000 + (parsed.revision || 0);
  if (!Number.isSafeInteger(code) || code <= 0 || code > 2147483647) throw new Error(`Android versionCode outside supported range: ${value}`);
  return code;
}

function verifyAndroidVersionCode(current, previous) {
  const code = androidVersionCode(current);
  if (previous && (compareProjectVersions(current, previous) !== 1 || code <= androidVersionCode(previous))) {
    throw new Error(`Android release must increase project version and versionCode: ${previous} -> ${current}`);
  }
  return code;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  try {
    const version = option('--version') || fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
    const code = verifyAndroidVersionCode(version, option('--previous'));
    console.log(`Android ${version}: versionCode=${code}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { androidVersionCode, verifyAndroidVersionCode };