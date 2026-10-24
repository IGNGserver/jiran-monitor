'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { precompressWebFiles } = require('../../scripts/build-web');

test('web precompression produces both representations without adding public/PWA dependencies', async (t) => {
  const scratch = process.env.BUILD_SCRATCH_ROOT || path.join(os.homedir(), '.build');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'jiran-precompression-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'assets'));
  const body = Buffer.from('resource content from this build\n'.repeat(100));
  const files = ['index.html', 'sw.js', 'manifest.webmanifest', 'asset-manifest.json',
    'assets/app-ABCDEFGH.js', 'assets/styles-ABCDEFGH.css', 'assets/source.js.map', 'assets/icon.svg', 'robots.txt'];
  for (const name of files) await fs.writeFile(path.join(root, name), body);
  await fs.writeFile(path.join(root, 'small.js'), 'small');
  await fs.writeFile(path.join(root, 'image.png'), body);
  await precompressWebFiles(root);
  for (const name of files) {
    const file = path.join(root, name);
    assert.deepEqual(zlib.gunzipSync(await fs.readFile(`${file}.gz`)), body);
    assert.deepEqual(zlib.brotliDecompressSync(await fs.readFile(`${file}.br`)), body);
    assert.deepEqual(await fs.readFile(file), body);
    const sourceStat = await fs.stat(file);
    assert.ok((await fs.stat(`${file}.gz`)).mtimeMs >= sourceStat.mtimeMs);
    assert.ok((await fs.stat(`${file}.br`)).mtimeMs >= sourceStat.mtimeMs);
  }
  for (const name of ['small.js.gz', 'small.js.br', 'image.png.gz', 'image.png.br', 'index.html.br.br', 'index.html.gz.gz']) {
    await assert.rejects(fs.stat(path.join(root, name)), { code: 'ENOENT' });
  }
  // A second pass must not recursively compress the transport siblings.
  await precompressWebFiles(root);
  await assert.rejects(fs.stat(path.join(root, 'index.html.br.gz')), { code: 'ENOENT' });
});
