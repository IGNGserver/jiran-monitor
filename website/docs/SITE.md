# 官网定位与范围（SITE）

> 本文为后续开发者（含 AI 会话）提供站点上下文。范围或技术决策变化时同步更新本文件。

## 是什么

计然 / Jiran 的产品官网：介绍产品、展示截图、提供下载入口与文档链接，并作为搜索引擎与
AI 工具的可引用入口。站点源码位于产品仓库的 `website/`：

| 事项 | 归属 |
| --- | --- |
| 产品功能、版本、发布资产、产品文档 | 产品仓库 `IGNGserver/jiran-monitor`（`website/` 之外） |
| 页面、样式、静态资源、SEO、站点文案 | `IGNGserver/jiran-monitor/website/` |

## 当前状态（2026-10-25）

- 中文首页 `/`、英文首页 `/en/`、`404`；纯静态输出；
- 已部署到 Cloudflare Pages，正式地址 `https://jiran.igng.net/`；
- `.github/workflows/website.yml` 在 `main` 与正式版 Release 后自动构建并部署；
- 旧的独立仓库 `IGNGserver/jiran-website` 已归档，代码与历史以产品仓库为准。

## 已定案

| 事项 | 结论 |
| --- | --- |
| 技术栈 | Astro 7 静态输出 + TypeScript；首屏 three.js（懒加载）；pnpm；字体自托管 |
| 页面结构 | 单页长卷：首屏 + 七章（名 / 问 / 则 / 汇 / 界 / 源 / 取），章节锚点 `#name` `#questions` `#rules` `#flow` `#privacy` `#sources` `#install` |
| 语言 | 简体中文为默认（`/`），英文 `/en/`；两份文案在 `src/i18n/content.ts`，测试保证结构一致；`hreflang` 互指 |
| 视觉方向 | 「刻漏」（2026-10-15 取代「算仪」）：宣纸底、墨字、青瓷器物与水，朱砂只作印；主标语「点滴有数」；标识沿用产品图标的开口刻度环几何。详见 `design/DESIGN.md` |
| 下载入口 | 构建时读取最新的非 prerelease 发布并烘焙直链；浏览器端再向 GitHub 刷新一次；失败退回 Releases 页面。`findStableRelease()` 分页查找，正式版不会被大量 prerelease 挤出第一页 |
| Linux 安装 | 直接下载 GitHub Releases 的 `.deb` / AppImage；不再维护 APT 仓库 |
| 隐私 | 无统计脚本、无 Cookie；唯一外部请求是 GitHub API（读版本号） |

## 待办 / 已知问题

- [ ] 产品真实界面截图：产品仓库目前只有 Fluent 2 概念图，没有发布版界面截图，站点暂以示意仪表代替；
- [ ] 站点事实（`src/data/product.ts`）目前靠人工核对；后续可加产品仓库导出的 facts 文件或定时漂移检查；
- [ ] 如需让新功能在站面上出现，优先补一个由 GitHub Releases 生成的 `/releases/` 页面，而不是反复重写营销长页。

## 内容原则

- 只陈述产品仓库当前支持的事实，不编造路线图；版本与平台矩阵以产品仓库 `README.md` / `docs/supported-tools.md` 为准；
- 下载链接指向产品仓库的 Releases，不在本仓库托管安装包；
- 品牌名遵循产品仓库规范：zh 显示“计然”，en/ja/ko 显示“Jiran”；
- 版本标签区分「正式版」与开发版：页面显示最新非 prerelease；开发版通过 Releases 链接查看。
