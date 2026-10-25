// @ts-check
import { defineConfig } from 'astro/config';
import earlyHints from './src/integrations/early-hints.mjs';

// 正式域名 https://jiran.igng.net/（见 docs/HOSTING.md），用作 canonical / hreflang / og:image 的绝对地址。
// SITE_URL 仅在预览或迁移验证时覆盖；缺省值必须是正式域名，否则部署到新域名时 SEO 标签会退化。
const site = process.env.SITE_URL || 'https://jiran.igng.net/';

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'always',
  // 样式表内联进 HTML：省掉首屏前的渲染阻塞请求（全站只有两页，跨页缓存样式的收益很小）
  build: { format: 'directory', inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
  integrations: [earlyHints()],
  vite: {
    build: { assetsInlineLimit: 2048 },
  },
});
