'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const sharp = require('sharp');

/** One opaque, square brand master; OS masks are applied after installation. */
async function buildPwaIcons({ source, outdir }) {
  const master = path.join(source, 'icons/icon-1024.png');
  const icons = {};
  const specs = [
    ...[192, 512, 1024].map((size) => [`icon-${size}.png`, size, false]),
    ...[192, 512, 1024].map((size) => [`icon-${size}-maskable.png`, size, true]),
    ...[180, 167, 152].map((size) => [`apple-touch-icon-${size}.png`, size, false])
  ];
  for (const [name, size, maskable] of specs) {
    const inset = maskable ? Math.round(size * 0.08) : 0;
    const image = sharp(master).flatten({ background: '#050a22' })
      .resize(size - inset * 2, size - inset * 2, { fit: 'contain' });
    if (inset) image.extend({ top: inset, right: inset, bottom: inset, left: inset, background: '#050a22' });
    const bytes = await image.removeAlpha().png().toBuffer();
    const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const url = `/icons/pwa-${digest}-${name}`;
    await fs.writeFile(path.join(outdir, url.slice(1)), bytes);
    icons[`/icons/${name}`] = url;
  }
  await fs.copyFile(path.join(outdir, icons['/icons/apple-touch-icon-180.png'].slice(1)), path.join(outdir, 'apple-touch-icon.png'));
  return icons;
}
module.exports = { buildPwaIcons };
