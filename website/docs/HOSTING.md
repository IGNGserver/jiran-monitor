# 托管与部署（Cloudflare Pages）

> 正式站点：<https://jiran.igng.net/>。站点源码在产品仓库的 `website/`，部署由
> `.github/workflows/website.yml` 完成。旧的独立仓库 `IGNGserver/jiran-website` 已归档，仅作历史。

## 当前配置

| 项 | 值 |
| --- | --- |
| Pages 项目 | `jiran-website`（Direct Upload） |
| 部署来源 | 产品仓库 `IGNGserver/jiran-monitor` 的 `website/` |
| 部署工作流 | `.github/workflows/website.yml` |
| 生产分支 | `main` |
| 构建命令 | `pnpm install --frozen-lockfile && pnpm build`（在 `website/` 下） |
| 输出目录 | `website/dist/` |
| 自定义域名 | `https://jiran.igng.net/`（zone `igng.net`） |
| 默认别名 | `https://jiran-website.pages.dev/`（保留） |
| DNS | proxied CNAME `jiran.igng.net` → `jiran-website.pages.dev` |

`SITE_URL` 固定为 `https://jiran.igng.net/`，用于 canonical、hreflang 与 `og:image`。CI、Pages 项目
环境变量与 `astro.config.mjs` 的缺省值必须保持一致。

## 自动部署

`website.yml` 在这些时机运行：

- `push` 到 `main` 且改动涉及 `website/**`：构建并部署；
- `Release` 工作流创建完 GitHub Release 后发送 `repository_dispatch`（`release-published`）：
  重建站点，重新烘焙版本号与下载直链；
- `pull_request`：只跑 `pnpm build` 与 Playwright，不部署；
- `workflow_dispatch`：手动构建与部署。

`release: published` 不能用于这条链路：Release 是由 `GITHUB_TOKEN` 创建的，GitHub 不会为
`GITHUB_TOKEN` 触发的事件再启动工作流；`repository_dispatch` 是例外。

部署步骤使用 `cloudflare/wrangler-action@v3`：

```bash
wrangler pages deploy dist --project-name jiran-website --branch main
```

需要两个 repository secrets：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 最小权限 token，仅需 Cloudflare Pages:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |

凭据只放 GitHub Actions Secrets，不写进仓库、文档、日志或前端产物。不要把 Pages 项目改成
Git 集成或新建项目：现有 Direct Upload 项目已经绑定 `jiran.igng.net`，重建会带来 DNS 与 SEO 迁移成本。

## 构建参数

| 项 | 值 |
| --- | --- |
| 安装 | `pnpm install --frozen-lockfile`（Node.js ≥ 22.13，`packageManager` 已锁定） |
| 构建 | `pnpm build`（`astro check && astro build`） |
| 输出 | `dist/`（含 `404.html`） |
| 响应头 | `public/_headers` 随产物发布：`/_astro/*` 一年 `immutable`；`src/integrations/early-hints.mjs` 为 `/`、`/en/` 追加字体预加载 `Link` 头，供 103 Early Hints 使用 |
| 可选环境变量 | `GITHUB_TOKEN`：构建时读发布信息，避开匿名限流；`JIRAN_OFFLINE=1`：离线构建，下载链接退回 Releases 页 |

版本号与下载直链在构建时烘焙，浏览器端再向 GitHub 刷新一次；产品发版后即使不重新部署也能显示
新的正式版，但无 JS 或 GitHub 限流时显示的是上次构建时的版本。`findStableRelease()` 会分页查找
最新非 prerelease，避免正式版被大量 prerelease 挤出第一页。

## 发布与回滚

- 正常发布：合并到 `main` 或发布正式版 Release，工作流自动部署；
- 回滚：在 Cloudflare Pages 项目 → Deployments 中选择上一个成功部署并恢复；
- 部署后验证：`/`、`/en/` 返回 200，未知路径返回 404，`_headers` 生效，下载直链指向当前正式版；
- 域名变更：修改 DNS 前记录原值；当前记录是 proxied CNAME `jiran.igng.net` → `jiran-website.pages.dev`，
  改动必须同步 Pages 自定义域名与三处 `SITE_URL`。

## 搜索收录

- Bing Webmaster Tools：站点 `https://jiran.igng.net/` 已验证所有权，首页 `<meta name="msvalidate.01">`
  不能删除，否则会失去所有权记录；sitemap 已提交 `/sitemap.xml`、`/` 与 `/en/`。
- Google Search Console：域名资源 `sc-domain:igng.net` 已覆盖；`public/sitemap.xml` 是手工维护的，
  新增页面必须同步补充。
- 站点没有统计脚本、Cookie 或第三方请求；唯一外部请求是向 GitHub 读取版本号。

## 历史

- 2026-10-15：首版 Astro 站点上线 Cloudflare Pages，项目 `jiran-website`。
- 2026-10-17：绑定 `jiran.igng.net`，`SITE_URL` 切换为正式域名。
- 2026-10-19：加载性能优化（字体子集、长期缓存、103 Early Hints），最后一次手动 Direct Upload。
- 2026-10-25：站点代码并入产品仓库 `website/`，改为 GitHub Actions 自动部署；独立仓库归档。
