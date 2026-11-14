# 官网定位与范围（SITE）

> 本文为后续开发者（含 AI 会话）提供站点上下文。范围或技术决策变化时同步更新本文件。

## 是什么

计然 / Jiran 的产品官网：通过参数化五层光学计量机芯（`JR-01`）、1:1 真实产品交互工作台与零外泄拓扑沙盒展示核心能力、提供全平台下载入口与自建 Hub 指引，并作为搜索引擎与开发者的可信事实入口。站点源码位于产品仓库的 `website/`：

| 事项 | 归属 |
| --- | --- |
| 产品功能、版本、发布资产、产品文档 | 产品仓库 `IGNGserver/jiran-monitor`（`website/` 之外） |
| 页面、三维舞台与 Blender 母版、交互工作台、静态资源、SEO、站点文案 | `IGNGserver/jiran-monitor/website/` |

## 当前状态

- 中文首页 `/`、英文首页 `/en/`、`404`；纯静态输出；
- 已部署到 Cloudflare Pages，正式地址 `https://jiran.igng.net/`；
- `.github/workflows/website.yml` 在 `main` 与正式版 Release 后自动构建并部署；
- 旧的独立仓库 `IGNGserver/jiran-website` 已归档，代码与历史以产品仓库为准。

## 已定案

| 事项 | 结论 |
| --- | --- |
| 技术栈 | Astro 7 静态输出 + TypeScript；全局空间舞台（Blender 5.2 Cycles 静帧 + `gltfpack` meshopt GLB + Three.js WebGL2，空闲按需懒加载）；pnpm；可变字体自托管 |
| 叙事结构 | 全局 `<Stage />` 贯穿首尾 + 六幕紧凑叙事：首屏（`#top`）、五层爆炸剖面与计量五律（`#anatomy`）、1:1 Fluent 2 实机交互工作台（`#workbench`）、零外泄光学门拓扑沙盒与四端规格（`#architecture`）、59 支持源游丝台账（`#sources`）、54° 冠冕回归下载与等距 Hub 堆栈（`#install`） |
| 语言 | 简体中文为默认（`/`），英文 `/en/`；两份文案在 `src/i18n/content.ts`，`tests/facts.spec.ts` 强制结构 1:1 对齐；`hreflang` 互指 |
| 视觉方向 | **光学计量暗室（Precision Optical Metrology）**：无彩色黑曜石底板（`#050608`）、铂银油墨（`#edf0f5`）、1px 建筑游丝分割，严守冰青（`#56ccf2`，Token 与配额）与香槟黄铜（`#e5a94c`，货币成本与独立 Credits）双信号色彩纪律。详见 `design/DESIGN.md` |
| 下载入口 | 构建时读取最新非 prerelease 正式版烘焙直链；浏览器端在 `load` 后空闲时向 GitHub 刷新一次；失败退回烘焙值或 Releases 页 |
| Linux 安装 | 直接下载 GitHub Releases 的 `.deb` / AppImage；不再维护 APT 仓库 |
| 隐私 | 无统计脚本、无 Cookie、无第三方字体 CDN；唯一外部请求是读取 GitHub Releases 最新正式版标签 |

## 内容原则

- 只陈述产品仓库当前支持的事实，不编造路线图；支持矩阵与计数以 `README.md` / `docs/supported-tools.md` 为准；
- 下载链接只由仓库常量与校验过的安全段构造，不在站点仓库托管二进制安装包；
- 品牌名遵循产品规范：`zh` 显示「计然」，`en` 显示「Jiran」；
- 交互工作台明确标注模拟车队数据，且严格遵守产品自身的五条计量诚实准则。
