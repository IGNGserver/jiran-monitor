# 工作区、分支与构建区

官网源码已经并入产品仓库的 `website/`，不再有独立的站点仓库。Git 纪律、worktree 路径与生命周期
以仓库根目录 `AGENTS.md` 和设备级规范为准；本文只记录站点相关的差异。

## 目录布局

```text
~/项目/token记录系统/                    # 产品仓库锚点，不用于开发
~/项目/.wt/token记录系统/<task-slug>/    # 任务 worktree，唯一开发位置
  └─ website/                            # 官网源码
```

所有改动（包括站点改动）都从 `origin/main` 建 worktree，不在主目录改文件或建提交。

## 创建任务 worktree

```bash
REPO=~/项目/token记录系统
git -C "$REPO" fetch origin --prune
BASE=$(git -C "$REPO" symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's|^origin/||')
test "$BASE" = main
PATH="$HOME/.local/bin:$PATH" wt new token记录系统 site-homepage
```

`wt` 不可用时的等价命令：

```bash
git -C "$REPO" worktree add ~/项目/.wt/token记录系统/site-homepage -b agent/site-homepage origin/main
```

使用等价命令时也必须确认 worktree 的 `HEAD` 与创建时的 `origin/main` 一致。

## 构建区（依赖与产物不落在项目卷）

NAS 卷上装依赖、跑构建是几十分钟量级，且违反设备级规范第 5c 节。源码在 worktree 里改，
只把 `website/` 单向同步到本机盘构建：

```bash
WT=~/项目/.wt/token记录系统/<task-slug>
SCR=${BUILD_SCRATCH_ROOT:-$HOME/.build}/token记录系统/<task-slug>
mkdir -p "$SCR"
rsync -a --delete --exclude node_modules --exclude dist --exclude .astro --exclude test-results "$WT/website/" "$SCR/"
cd "$SCR" && pnpm install --frozen-lockfile
pnpm build && pnpm test
PLAYWRIGHT_BROWSERS_PATH=${BUILD_SCRATCH_ROOT:-$HOME/.build}/ms-playwright pnpm exec playwright install chromium
```

- 依赖变更（`pnpm add`）在构建区执行，然后把 `package.json`、`pnpm-lock.yaml` 拷回 worktree 再提交；
- 构建区是可丢弃的副本：不在里面提交，也不把 `dist/`、截图等产物写回 worktree；
- 本地构建前先 `df -h` 确认构建区所在磁盘可用空间 ≥ 20G，否则只跑快速检查、构建交给 PR 上的 CI。

## 收尾

```bash
cd ~/项目/.wt/token记录系统/<task-slug>
git status --short
git diff --check
git push -u origin agent/<task-slug>
PATH="$HOME/.local/bin:$PATH" wt done token记录系统 <task-slug>
```

`wt done` 遇到未提交或未推送内容会保护性停止；清理前必须确认没有未提交改动。

## 集成与部署

`main` 受分支保护：必须经 PR，且 CI 检查通过（solo 模式验证通过后 Agent 可自行合并）。
合并后 `.github/workflows/website.yml` 会自动构建并部署到 Cloudflare Pages，不再需要手动上传
artifact。部署与回滚细节见 [`HOSTING.md`](HOSTING.md)。
