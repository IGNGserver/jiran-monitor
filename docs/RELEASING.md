# 发布说明

`.github/workflows/release.yml` 使用 `v<版本号>` tag 构建并创建 GitHub Release。版本真源为仓库根目录的 `VERSION` 文件，项目版本格式遵循语义化版本：

```text
<major>.<minor>.<patch>
```

（历史/过渡版本的 `-rev.N` 格式由解析器向下兼容支持）。版本字符串必须通过 `npm run verify:release-version` 校验（强制与 `VERSION`、`package.json`、`package-lock.json` 同步并严格递增）。

发布类型和版本字符串是两个独立概念：GitHub Release 是否标记为 prerelease 由发布流程决定。普通的“发布 release”按 prerelease 处理；只有明确要求“发布正式版 release”时，才选择正式版。正式版还会更新 Docker 镜像的 `latest` 标签，版本化标签则始终发布。

## 更新通道与 Latest 标记

桌面客户端的更新通道是用户设置（默认 `stable`），不再根据已安装版本字符串推断：

- `stable` 只接受 `prerelease: false` 且版本号不带 prerelease 后缀的发布；
- `prerelease` 接受预发布构建，也接受更新的正式版；
- 从预发布通道切回稳定版不会自动降级，客户端会在下一个正式版发布时更新。

版本号与发布类型相互独立：`1.4.3` 可以是 semver 意义上的正式版本，同时在 GitHub 上标记为 prerelease。客户端以 GitHub 的 prerelease 标记为准。

`softprops/action-gh-release` 必须显式设置 `make_latest`：正式版为 `true`，prerelease 为 `false`。否则 GitHub 的 `/releases/latest` 会停留在旧正式版（例如 `v1.2.1` 发布后仍指向 `v1.0.0`），electron-updater 的稳定通道路径就解析不到新版本。

## 首次配置 Android 签名

Android 正式包必须使用长期保存的签名密钥。不要把 keystore 文件或密码提交到仓库。

在安全环境生成 keystore 后，将 keystore 转成 base64，并在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中配置以下 Repository secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

签名密钥一旦用于公开发布，就必须永久保留。后续版本必须使用同一密钥，否则 Android 无法覆盖更新旧版本。

## 发布新版本

1. 新建 `.github/release-notes/<版本号>.md`（文件名是无 `v` 前缀的项目版本号，例如 `0.47.0-rev.36.md`），把本次更新写进文件里的 `<!-- app-update-notes:zh:start -->` 与 `<!-- app-update-notes:zh:end -->` 之间。一个版本一个文件：模板 `.github/RELEASE_TEMPLATE.md` 只留 `{{release_notes}}` 占位符，发布时渲染脚本按 tag 的版本读取对应文件，旧版本的说明不会再累积进新 Release。发布正文只有中文；快捷下载列表、版本号与 Hub 镜像段都由 `scripts/generate-release-notes.js` 注入，不要手写 `releases/download/` 链接。结构约定见 `.github/RELEASE_NOTES_FORMAT.md`。

2. 在根目录 `VERSION`、`package.json` 和锁文件中同步版本号，例如 `1.0.0`，然后运行：

   ```bash
   npm run verify:release-version
   ```

3. 提交并推送代码。
4. 创建并推送同名版本 tag，例如：

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

   推送 tag 会自动创建 prerelease。
5. 如果要创建正式版，进入 GitHub Actions 手动运行 `Release`，填写同一个版本号，并将 `release_type` 选择为 `release`。只有这个明确操作会创建正式版 Release。
6. GitHub Actions 会构建 Windows 安装包、Linux AppImage、Debian `.deb` 包、Android release APK 和 Hub 镜像。Release 资产文件名中的 `<version>` 会保留完整版本号，例如：

   - `Jiran-Setup-1.0.0.exe`
   - `Jiran-1.0.0.AppImage`
   - `Jiran-1.0.0.deb`
   - `Jiran-Android-1.0.0.apk`

Android 的 `versionName` 与桌面版本一致；`versionCode` 由同一版本字符串推导（`major*10000 + minor*100 + patch`，再乘以 10000 加上 `rev.N`，无修订号时该位为 0），因此带或不带 `-rev.N` 的发布都能保持单调递增。

已安装的 Debian 版本通过应用内更新使用系统 `dpkg`/`apt` 完成升级，首次安装新版本时会按系统策略请求管理员权限；也可以手动执行 `sudo apt install ./Jiran-<version>.deb`。

## Debian 安装与升级

`.deb` 直接从 GitHub Releases 下载，用 `sudo apt install ./Jiran-<version>.deb` 安装；项目不再维护 APT 仓库，也没有仓库候选版本。App Center 能显示应用已安装，但不会显示仓库升级按钮；升级就是下载并安装新的 `.deb`。

旧 APT 仓库及其 `token-monitor` 过渡包已于 2026-10 退役。已配置旧源的用户应删除 `/etc/apt/sources.list.d/jiran.sources`（以及历史 `token-monitor.sources`），改用 Releases。

包保持稳定标识：`Package` 为 `jiran`，AppStream 组件 id 仍为 `com.igng.tokenmonitor.desktop`，并使用标准语义化 Debian 版本。

### 改名（计然 / Jiran）迁移面

- **GHCR**：主镜像为 `jiran-hub`，`token-monitor-hub` 在过渡期内仍被推送完全相同的标签；用户改镜像名或保持旧名都可以，过渡窗口结束后才停推旧名。
- **线协议**：Hub 同时接受 `X-Jiran-Secret` 与历史 `X-Token-Monitor-Secret`；env 同时接受 `JIRAN_*` 与 `TOKEN_MONITOR_*`（后者优先）。
- **SignPath**：portal 侧的 artifact-configuration 必须与仓内 `.github/signpath/*.xml` 同步（文件名已从 `Token-Monitor-*` 改为 `Jiran-*`），否则 Windows 签名步骤会因找不到 PE 而失败。

发布验证会检查 `.deb` 的 `Package`、原始 Debian `Version`、架构、桌面入口和 AppStream 元数据；AppStream 元数据用于让 App Center 正确识别应用。

## Windows 签名

当前 Windows 安装包可以正常构建。未配置 `SIGNPATH_API_TOKEN` 时，Release workflow 会自动跳过 SignPath，发布**未签名**的 Windows 包（用户首次运行可能看到 SmartScreen 警告）。配置 SignPath 的 `SIGNPATH_API_TOKEN` secret 后，同一 workflow 会走 SignPath 双阶段签名（应用本体 + 安装包/便携版）。

## Hub Docker 镜像（GHCR）

推送 `v*` tag 后，Release workflow 会额外：

1. 多架构构建并推送 `ghcr.io/<owner>/jiran-hub`（`linux/amd64` + `linux/arm64`）。
2. 始终打标签：`<version>`、`v<version>`；只有正式版 Release 额外更新 `latest`。
3. 打包 `Jiran-Hub-Compose-<version>.zip`（最小 compose 部署包）并挂到 Release Assets。

镜像名固定为 **`jiran-hub`**。Compose 通过环境变量 `JIRAN_VERSION` 选择标签，默认 `latest`。

首次在组织/账号下推送 GHCR 包后，如需匿名拉取，请到 GitHub → Packages → `jiran-hub` → Package settings 将可见性设为 **Public**。

本地验证 compose 包（不推镜像）：

```bash
node scripts/package-hub-compose.js 1.0.0
```

本地从源码构建（不经过 GHCR）：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml build hub
```
