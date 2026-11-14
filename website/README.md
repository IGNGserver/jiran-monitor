# 计然官网 · Jiran Website

计然 / Jiran 的产品官网、交互式实机演示工作台与下载入口，源码位于产品仓库的 `website/` 目录：

- 产品仓库（唯一事实来源）：<https://github.com/IGNGserver/jiran-monitor>
- 正式站点：<https://jiran.igng.net/>（Cloudflare Pages 项目 `jiran-website`）
- 部署：`.github/workflows/website.yml` 在 `main` 和正式版发布后构建并上传 `dist/`

产品源码、安装包与发布资产属于产品仓库的其余目录；本目录只承载页面、样式、静态资源与站点文档。
Linux 的 `.deb` 与 `AppImage` 直接从 GitHub Releases 下载，不再维护 APT 仓库。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/pages/` | 路由：`/`（简体中文）、`/en/`（英文）、`404` |
| `src/components/` | 首屏（`Hero`）、交互式产品工作台（`Workbench`）及能力、架构、准则、隐私、支持矩阵、安装组件 |
| `src/scripts/hero/` | 首屏「计算遥测核心」实时 WebGL2 场景（Three.js + 自定义 GLSL 着色器）；静帧母版同样由它确定性渲染 |
| `src/scripts/workbench.ts` | 1:1 复刻产品共享界面（`src/shared-ui`）的交互式演示工作台状态机与视图渲染 |
| `src/i18n/content.ts` | 中英文案（由 `tests/facts.spec.ts` 保证结构一致） |
| `src/data/` | 引用的产品事实（`product.ts`）、发布解析（`release.ts`）、客户端图标映射（`icons.ts`）与演示车队数据（`workbench.ts`） |
| `design/` | 计算遥测视觉规范（`DESIGN.md`、`palette.json`）及静帧与社交卡片生成脚本（`tools/stills.mjs`、`tools/media.mjs`） |
| `tests/` | Playwright 端到端检查、预算校验与事实一致性测试 |
| [`docs/SITE.md`](docs/SITE.md) | 官网定位、范围与已定案事项 |
| [`docs/HOSTING.md`](docs/HOSTING.md) | Cloudflare Pages 托管、部署与回滚 |
| [`docs/WORKSPACE.md`](docs/WORKSPACE.md) | 本机 worktree 与构建区约定 |

## 开发

```bash
cd website
pnpm install --frozen-lockfile
pnpm dev          # http://localhost:4321
pnpm build        # astro check + 静态构建到 dist/
pnpm test         # Playwright（先 build；首次需 pnpm exec playwright install chromium）
```

构建依赖和 `dist/` 不得落在项目源码卷上；在 `$BUILD_SCRATCH_ROOT` 的副本里安装与构建，
步骤见 [`docs/WORKSPACE.md`](docs/WORKSPACE.md)。Git 纪律与 PR 流程见仓库根目录的 `AGENTS.md`。

## 许可

[MIT](../LICENSE)
