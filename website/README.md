# 计然官网 · Jiran Website

计然 / Jiran 的产品官网与下载入口，源码位于产品仓库的 `website/` 目录：

- 产品仓库（唯一事实来源）：<https://github.com/IGNGserver/jiran-monitor>
- 正式站点：<https://jiran.igng.net/>（Cloudflare Pages 项目 `jiran-website`）
- 部署：`.github/workflows/website.yml` 在 `main` 和正式版发布后构建并上传 `dist/`

产品源码、安装包与发布资产属于产品仓库的其余目录；本目录只承载页面、样式、静态资源与站点文档。
Linux 的 `.deb` 直接从 GitHub Releases 下载，不再维护 APT 仓库。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/pages/` | 路由：`/`（中文）、`/en/`、`404` |
| `src/components/` | 首屏与七个章节组件 |
| `src/scripts/hero/` | 首屏「刻漏」实时场景（three.js、水面着色器）；静帧也由它渲染 |
| `src/i18n/content.ts` | 中英文案 |
| `src/data/product.ts` | 引用的产品事实（支持矩阵、计数、链接），注明核对基线 |
| `design/` | 设计说明、共享几何与配色 spec（`kelou.json`）、静帧与图片生成脚本 |
| `tests/` | Playwright 端到端检查与事实一致性测试 |
| [`docs/SITE.md`](docs/SITE.md) | 官网定位、范围、已定案事项与待办 |
| [`docs/HOSTING.md`](docs/HOSTING.md) | Cloudflare 托管、部署与回滚 |
| [`docs/WORKSPACE.md`](docs/WORKSPACE.md) | 本机 worktree 与构建区约定 |

## 开发

```bash
cd website
pnpm install
pnpm dev          # http://localhost:4321
pnpm build        # astro check + 静态构建到 dist/
pnpm test         # Playwright（先 build；首次需 pnpm exec playwright install chromium）
```

构建依赖和 `dist/` 不得落在 NAS 项目卷上；在 `$BUILD_SCRATCH_ROOT` 的副本里安装与构建，
步骤见 [`docs/WORKSPACE.md`](docs/WORKSPACE.md)。Git 纪律与 PR 流程见仓库根目录的 `AGENTS.md`。

## 许可

[MIT](../LICENSE)
