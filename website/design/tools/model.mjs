#!/usr/bin/env node
/**
 * 将 Blender 导出的原始 GLB 压缩为站点运行时加载的模型：
 *   node design/tools/model.mjs <meter_raw.glb>
 *
 * 使用 gltfpack 开启 meshopt 压缩（-cc）并保留节点名（-kn，供 Three.js 按 L_<id> /
 * drum_outer / drum_inner / credits_rotor 索引）与材质名（-km，供 Three.js 覆写玻璃与发光强度）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const input = process.argv[2];
if (!input) {
  console.error('usage: node design/tools/model.mjs <meter_raw.glb>');
  process.exit(1);
}
const outputDir = path.join(root, 'public/models');
mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, 'meter.glb');
execFileSync(path.join(root, 'node_modules/.bin/gltfpack'), ['-i', input, '-o', output, '-cc', '-kn', '-km'], {
  stdio: 'inherit',
});
console.log('wrote', path.relative(root, output), statSync(output).size, 'bytes');
