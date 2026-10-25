#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');
const esbuild = require('esbuild-wasm');
const { injectManifest } = require('workbox-build');
const { buildPwaIcons } = require('./build-pwa-icons');

const ROOT = path.resolve(__dirname, '..');

// Siblings are transport variants only: the PWA graph and HTML keep referencing
// the original content-addressed asset URLs. Walk one file at a time so adding
// resources cannot turn this into an unbounded in-memory compression queue.
async function precompressWebFiles(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await precompressWebFiles(file);
    } else if (entry.isFile() && /\.(?:html|js|css|json|map|svg|txt|webmanifest)$/i.test(entry.name)) {
      if ((await fs.stat(file)).size < 1024) continue;
      await Promise.all([
        pipeline(createReadStream(file), zlib.createGzip({ level: 9 }), createWriteStream(`${file}.gz`)),
        pipeline(createReadStream(file), zlib.createBrotliCompress({
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 }
        }), createWriteStream(`${file}.br`))
      ]);
    }
  }
}

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
  const icons = await buildPwaIcons({ source, outdir });
  const versionIcons = (text) => Object.entries(icons).reduce((result, [old, url]) => result.replaceAll(old, url), text);
  const webManifest = versionIcons(await fs.readFile(path.join(source, 'manifest.webmanifest'), 'utf8'));
  await fs.writeFile(path.join(outdir, 'manifest.webmanifest'), webManifest);
  const html = versionIcons(await fs.readFile(path.join(source, 'index.html'), 'utf8'))
    .replace('/ui/styles/app.css', publicPath(stylesheet))
    .replace('/js/boot.js', publicPath(script))
    .replace('</head>', '<meta name="jiran-pwa-build" content="1" /></head>');
  await fs.writeFile(path.join(outdir, 'index.html'), html);
  const template = await fs.readFile(path.join(source, 'sw.js'), 'utf8');
  const revision = crypto.createHash('sha256').update(html).update(webManifest).update(template);
  for (const file of outputs.sort()) revision.update(await fs.readFile(file));
  const version = revision.digest('hex').slice(0, 20);
  // The bundler and generated icons supply the complete graph. A shell version
  // activates only after every listed resource is available.
  const precache = ['/index.html', '/manifest.webmanifest', ...outputs.map(publicPath), ...Object.values(icons)];
  const workerBundle = await esbuild.build({
    absWorkingDir: ROOT,
    stdin: { contents: template.replace("'jiran-web-development'", `'jiran-web-${version}'`), resolveDir: path.join(source), sourcefile: 'sw.js' },
    bundle: true, format: 'iife', platform: 'browser', target: ['safari15'], minify: true,
    define: { 'process.env.NODE_ENV': '"production"' }, write: false
  });
  const candidate = path.join(outdir, '.sw-inject.js');
  await fs.writeFile(candidate, workerBundle.outputFiles[0].text);
  try {
    await injectManifest({
      swSrc: candidate, swDest: path.join(outdir, 'sw.js'), globDirectory: outdir, globPatterns: [],
      additionalManifestEntries: await Promise.all(precache.map(async (url) => ({
        url, revision: url.startsWith('/assets/') || url.startsWith('/icons/pwa-') ? null
          : crypto.createHash('sha256').update(await fs.readFile(path.join(outdir, url.slice(1)))).digest('hex')
      })))
    });
  } finally { await fs.rm(candidate, { force: true }); }
  const manifest = { version, precache, outputs: result.metafile.outputs };
  await fs.writeFile(path.join(outdir, 'asset-manifest.json'), JSON.stringify(manifest, null, 2));
  await precompressWebFiles(outdir);
  console.log(`Web assets: ${outputs.length} hashed files; PWA revision ${version}`);
  return manifest;
}

if (require.main === module) buildWeb().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildWeb, precompressWebFiles };
