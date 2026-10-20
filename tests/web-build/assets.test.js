'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '../../dist/web');

test('built shell and PWA reference the complete hashed bundler graph', { skip: !fs.existsSync(path.join(root, 'asset-manifest.json')) && 'run npm run build:web first' }, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'asset-manifest.json')));
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.equal(manifest.precache.length, 3, 'one complete JS bundle, one CSS bundle, one shell');
  assert.ok(!html.includes('/js/boot.js'));
  assert.ok(!html.includes('/ui/styles/app.css'));
  for (const asset of manifest.precache) {
    assert.ok(fs.existsSync(path.join(root, asset)));
    assert.ok(sw.includes(asset));
    if (asset.endsWith('.js') || asset.endsWith('.css')) assert.match(asset, /-[A-Z0-9]{8}\.(js|css)$/);
    if (asset.endsWith('.js')) {
      const body = fs.readFileSync(path.join(root, asset));
      assert.ok(zlib.gzipSync(body).length < 250_000, 'critical JS gzip budget');
      assert.ok(!/import\(["']\/ui\//.test(body.toString()), 'no runtime source-module waterfall');
    }
  }
  assert.ok(sw.includes(`jiran-web-${manifest.version}`));
});
