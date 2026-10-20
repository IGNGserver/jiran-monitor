#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const esbuild = require('esbuild-wasm');

const ROOT = path.resolve(__dirname, '..');

async function buildWeb({ outdir = path.join(ROOT, 'dist/web') } = {}) {
  const source = path.join(ROOT, 'src/hub/web');
  const ui = path.join(ROOT, 'src/shared-ui');
  await fs.mkdir(outdir, { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: { app: 'src/hub/web/js/boot.js', styles: 'src/shared-ui/styles/app.css' },
    outdir: path.join(outdir, 'assets'), entryNames: '[name]-[hash]',
    bundle: true, splitting: false, format: 'esm', platform: 'browser',
    target: ['es2022'], minify: true, metafile: true, write: true,
    plugins: [{ name: 'shared-ui-root', setup(build) {
      build.onResolve({ filter: /^\/ui\// }, ({ path: specifier }) => ({ path: path.join(ui, specifier.slice(4)) }));
    } }]
  });
  const outputs = Object.keys(result.metafile.outputs).map((file) => path.resolve(ROOT, file));
  const publicPath = (file) => `/${path.relative(outdir, file).split(path.sep).join('/')}`;
  const script = outputs.find((file) => file.endsWith('.js'));
  const stylesheet = outputs.find((file) => file.endsWith('.css'));
  if (!script || !stylesheet) throw new Error('Missing browser entry points');
  for (const name of ['icons', 'favicon.png', 'manifest.webmanifest']) {
    await fs.cp(path.join(source, name), path.join(outdir, name), { recursive: true });
  }
  const html = (await fs.readFile(path.join(source, 'index.html'), 'utf8'))
    .replace('/ui/styles/app.css', publicPath(stylesheet))
    .replace('/js/boot.js', publicPath(script));
  await fs.writeFile(path.join(outdir, 'index.html'), html);
  const template = await fs.readFile(path.join(source, 'sw.js'), 'utf8');
  const revision = crypto.createHash('sha256').update(html).update(template);
  for (const file of outputs.sort()) revision.update(await fs.readFile(file));
  const version = revision.digest('hex').slice(0, 20);
  // Required resources come from the bundler graph, not a hand-maintained list
  // of modules. All application code is in the one JS file, including lazy imports.
  const precache = ['/index.html', ...outputs.map(publicPath)];
  const sw = template.replace("'jiran-web-development'", `'jiran-web-${version}'`)
    .replace('/* generated-precache */ []', JSON.stringify(precache));
  await fs.writeFile(path.join(outdir, 'sw.js'), sw);
  const manifest = { version, precache, outputs: result.metafile.outputs };
  await fs.writeFile(path.join(outdir, 'asset-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Web assets: ${outputs.length} hashed files; PWA revision ${version}`);
  return manifest;
}

if (require.main === module) buildWeb().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildWeb };
