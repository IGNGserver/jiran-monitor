# 发布正文格式

`.github/RELEASE_TEMPLATE.md` 是每次 GitHub Release 正文的**结构**模板；`.github/release-notes/<version>.md`
是每一次发布**本次更新**的唯一来源。`.github/workflows/release.yml` 的 release job 调用
`scripts/generate-release-notes.js --version <tag 版本>` 渲染：脚本按版本读取
`.github/release-notes/<version>.md`，注入模板的 `{{release_notes}}` 占位符，产出 `release-body.md`
后交给 `softprops/action-gh-release` 的 `body_path`。

**为什么按版本分文件：** 早先模板里只有一个 `app-update-notes:zh` 标记区，每次发版都往区顶追加小节、
从不删除旧内容，于是每一条 Release 的「本次更新」都是全部历史，`latest*.yml` 的 `releaseNotes`
同样把历史塞进应用内更新。累积只靠习惯刹车，习惯必然失守；现在一次发布只能渲染自己版本的说明文件，
跨版本累积在结构上不可能，缺文件则直接发布失败。旧的 `app-update-notes:zh` 标记区已不允许再回到模板
——渲染脚本发现模板里出现这对标记会直接报错。

正文只有中文。这是明确的产品决定，不是遗漏：英文段与繁體中文／한국어／日本語段此前由模板手写、
脚本只替换 `en`／`zh` 两处，于是那几个语言每次发出去的都是**上一个版本**的内容；GitHub 自动生成的
changelog 是英文 PR 列表，且没有任何 workflow 步骤去填充它，那块 `Full Changelog` 折叠区一直发的是空块。
两类失效都由"同一段内容存在多个副本、其中一个没人维护"造成，所以不再保留第二语言。

## 结构（自上而下）

```markdown
# Jiran {{tag}}

## 本次更新

{{release_notes}}

## 快捷下载

<!-- release-downloads -->

<details>
<summary><strong>首次启动与其他说明</strong></summary>

（各平台首次启动、签名、AppImage 执行权限、`.deb` 直接安装、Android 覆盖安装、tokscale 依赖）

</details>

<!-- release-hub-image -->
```

而 `.github/release-notes/<version>.md` 自身的形状是：

```markdown
<!-- app-update-notes:zh:start -->
### 小节
- 条目
<!-- app-update-notes:zh:end -->
```

- **本次更新**：每个版本一个文件（文件名是无 `v` 前缀的项目版本号，如 `0.47.0-rev.35.md`），
  由人在打 tag 之前写，脚本不从 commit 标题生成条目。标记对 `app-update-notes:zh:start` / `:end`
  在说明文件里必须各出现一次，且区内不能只剩标题——只剩 `###` 时渲染直接失败，避免发出一份没写内容的
  说明。写成 `### 小节` + `- 条目` 才会同时进入应用内更新读取的结构化说明（`extractReleaseNotes`）；
  写成自然段落只在 release 页面显示，两种都可以。说明文件里**不要**放 `<!-- release-downloads -->`、
  `<!-- release-hub-image -->` 这类结构标记，渲染脚本会拒绝。
- **快捷下载**：整段由 `RELEASE_ARTIFACTS` 表生成，模板与说明里都**不要**手写任何
  `releases/download/` 链接。产物名的单一来源就是这张表，
  `tests/shared/releaseArtifactNames.test.js` 把它与 `package.json` 里的
  `build.mac/linux/nsis/portable.artifactName`、Android job 的 APK 文件名以及 release job 的上传
  glob 逐条对齐；`tests/shared/releaseNotesGenerator.test.js` 再断言安卓 APK 与 `.deb` 必须在列表里。
- **Hub 镜像与 Compose**：由 `hubDeploymentSection()` 生成，按 `release_type` 决定是否提到 `latest`
  （prerelease 不移动 `latest`，见 AGENTS.md 的版本与发布策略）。
- **占位符**：`{{version}}`、`{{tag}}`、`{{repository}}`、`{{repositoryUrl}}`、`{{release_notes}}`。
  未知占位符，或渲染结果里仍残留 `{{`，都会让渲染失败。说明文件里可以使用上述版本占位符；除此之外，
  标记区内不要写死版本字符串。

`scripts/electron-builder.config.js` 在构建时把 `releaseInfo.releaseNotesFile` 解析为
**当前 `package.json` 版本**对应的说明文件，electron-builder 再把该文件原文塞进 `latest*.yml` 的
`releaseNotes`，应用内更新读到的永远是本版内容。`package.json` 里不再有 `build.releaseInfo`：
路径由 `releaseNotesPath()` 单一来源推导，缺文件时构建与发布都会带着"先写说明文件"的错误失败。
说明文件里的 `{{...}}` 只有标记区会被应用内更新解析，不会显示给用户。

## 发版前要做的只有一件事

新建 `.github/release-notes/<本版本版本号>.md`，把本次更新写进标记区；其余（链接、版本号、镜像标签）
都由流程注入。详见 `docs/RELEASING.md`。
