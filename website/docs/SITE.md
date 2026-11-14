# 官网定位与范围（SITE）

> 本文为后续开发者（含 AI 会话）提供站点上下文。范围或技术决策变化时同步更新本文件。

## 是什么

计然 / Jiran 的产品官网：通过可交互的真实产品工作台展示核心能力、提供全平台下载入口与自建 Hub 指引，并作为搜索引擎与开发者的可信事实入口。站点源码位于产品仓库的 `website/`：

| 事项 | 归属 |
| --- | --- |
| 产品功能、版本、发布资产、产品文档 | 产品仓库 `IGNGserver/jiran-monitor`（`website/` 之外） |
| 页面、交互工作台演示、三维场景、静态资源、SEO、站点文案 | `IGNGserver/jiran-monitor/website/` |

## 当前状态

- 中文首页 `/`、英文首页 `/en/`、`404`；纯静态输出；
- 已部署到 Cloudflare Pages，正式地址 `https://jiran.igng.net/`；
- `.github/workflows/website.yml` 在 `main` 与正式版 Release 后自动构建并部署；
- 旧的独立仓库 `IGNGserver/jiran-website` 已归档，代码与历史以产品仓库为准。

## 已定案

| 事项 | 结论 |
| --- | --- |
| 技术栈 | Astro 7 静态输出 + TypeScript；首屏 Three.js WebGL2 + 自定义 GLSL（空闲按需懒加载）；pnpm；可变字体自托管 |
| 叙事重心 | **产品本身是绝对主角**：首屏后紧接 1:1 复刻 `src/shared-ui` 结构的交互式产品工作台（`#workbench`），访问者可直接切换总览、模型工作台对比、订阅额度、WSL 设备与管理对账 |
| 页面结构 | 首屏（`#top`）+ 七章：交互工作台（`#workbench`）、核心能力（`#capabilities`）、四端架构（`#architecture`）、计量准则（`#principles`）、隐私边界（`#privacy`）、59 支持源矩阵（`#sources`）、下载与自建 Hub（`#install`） |
| 语言 | 简体中文为默认（`/`），英文 `/en/`；两份文案在 `src/i18n/content.ts`，测试保证结构一致；`hreflang` 互指 |
| 视觉方向 | **计算遥测美学（Computational Telemetry）**：与计然应用图标（`assets/icon.png`）及 Fluent 2 暗色工作台一脉相承的黑曜深空底色（`#060a14`）、电光青至钴蓝信号色（`#38bdf8` → `#0a84ff`）、高对比等宽遥测读数。详见 `design/DESIGN.md` |
| 下载入口 | 构建时读取最新非 prerelease 正式版烘焙直链；浏览器端在 `load` 后空闲时向 GitHub 刷新一次；失败退回烘焙值或 Releases 页 |
| Linux 安装 | 直接下载 GitHub Releases 的 `.deb` / AppImage；不再维护 APT 仓库 |
| 隐私 | 无统计脚本、无 Cookie、无第三方字体 CDN；唯一外部请求是读取 GitHub Releases 最新正式版标签 |

## 内容原则

- 只陈述产品仓库当前支持的事实，不编造路线图；支持矩阵与计数以 `README.md` / `docs/supported-tools.md` 为准；
- 下载链接只由仓库常量与校验过的安全段构造，不在站点仓库托管二进制安装包；
- 品牌名遵循产品规范：`zh` 显示「计然」，`en` 显示「Jiran」；
- 交互工作台明确标注「交互式实机演示 · 模拟车队数据」，且严格遵守产品自身的五条计量诚实准则。
