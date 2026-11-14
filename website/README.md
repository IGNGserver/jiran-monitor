# 计然官网 · Jiran Website

计然 / Jiran 的产品官网、JR-01 光学计量三维舞台、1:1 实机交互工作台与全平台下载入口，源码位于产品仓库的 `website/` 目录：

- 产品仓库（唯一事实来源）：<https://github.com/IGNGserver/jiran-monitor>
- 正式站点：<https://jiran.igng.net/>（Cloudflare Pages 项目 `jiran-website`）
- 部署：`.github/workflows/website.yml` 在 `main` 和正式版发布后构建并上传 `dist/`

产品源码、安装包与发布资产属于产品仓库的其余目录；本目录只承载页面、样式、三维与静态资源及站点文档。
Linux 的 `.deb` 与 `AppImage` 直接从 GitHub Releases 下载，不再维护 APT 仓库。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/pages/` | 路由：`/`（简体中文）、`/en/`（英文）、`404` |
| `src/components/` | 全局三维舞台（`Stage`）、首屏（`Hero`）、五层爆炸解构（`Anatomy`）、实机工作台（`Workbench`）、零外泄管线沙盒（`Flow`）、59 源台账（`Sources`）、下载与等距容器栈（`Install`） |
| `src/scripts/meter/` | `JR-01` 全局空间舞台（Three.js + PBR 玻璃透射 + GLSL 84 日双轨波面 + 滚动导演 `director.ts`） |
| `src/scripts/workbench.ts` | 1:1 复刻产品共享界面（`src/shared-ui`）的交互式演示工作台状态机与视图渲染 |
| `src/scripts/flow.ts` | 零外泄机械光阑粒子拦截、仅本机离线切换与 `>10m` Stale 休眠唤醒拓扑沙盒 |
| `src/i18n/content.ts` | 中英文案（由 `tests/facts.spec.ts` 强制保证结构一致） |
| `src/data/` | 引用的产品事实（`product.ts`）、发布解析（`release.ts`）、客户端图标映射（`icons.ts`）与演示车队数据（`workbench.ts`） |
| `design/` | 参数化机芯规范（`meter.json`）、Blender 5.2 Cycles 构建脚本（`blender/build_meter.py`）、`gltfpack` 压缩与媒体生成工具（`tools/model.mjs`、`tools/media.mjs`）及设计说明（`DESIGN.md`） |
| `tests/` | Playwright 端到端检查、首屏与 3D chunk 预算校验、字体及事实一致性测试 |
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
