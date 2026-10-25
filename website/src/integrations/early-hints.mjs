// @ts-check
import { readdir, readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

/**
 * 把每个页面里的 <link rel="preload"> 写进 dist/_headers 的 Link 响应头，让 Cloudflare 以 103 Early Hints 下发。
 *
 * Pages 本来会从 HTML 自动生成 Link 头，但带 crossorigin 的 <link> 会被跳过（见 Cloudflare 文档
 * Pages › Early Hints）；字体预加载必须带 crossorigin，否则浏览器会按非 CORS 模式取回而无法复用，
 * 所以这里显式生成。文件名带内容哈希，只能在构建完成后从产物里读。
 * @returns {import('astro').AstroIntegration}
 */
export default function earlyHints() {
  return {
    name: 'jiran:early-hints',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const pages = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('index.html')).sort();
        const rules = [];
        for (const file of pages) {
          const html = await readFile(join(root, file), 'utf8');
          const links = [...html.matchAll(/<link rel="preload"[^>]*>/g)].map(([tag]) => {
            /** @param {string} name */
            const attr = (name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
            const parts = [`<${attr('href')}>`, 'rel=preload'];
            if (attr('as')) parts.push(`as=${attr('as')}`);
            if (attr('type')) parts.push(`type="${attr('type')}"`);
            if (/\scrossorigin[\s>=]/.test(tag)) parts.push('crossorigin');
            return `  Link: ${parts.join('; ')}`;
          });
          if (!links.length) continue;
          const route = '/' + file.slice(0, -'index.html'.length).split(sep).join('/');
          rules.push(`${route}\n${links.join('\n')}`);
        }
        if (!rules.length) return;
        await appendFile(join(root, '_headers'), `\n# 以下由 src/integrations/early-hints.mjs 在构建时生成（首屏字体预加载 → 103 Early Hints）\n${rules.join('\n')}\n`);
        logger.info(`Link 头已写入 _headers：${rules.length} 个页面`);
      },
    },
  };
}
