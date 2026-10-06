# Jiran {{tag}}

## 本次更新

{{release_notes}}

## 快捷下载

<!-- release-downloads -->

<details>
<summary><strong>首次启动与其他说明</strong></summary>

### 首次启动

**macOS：** 应用已使用 Developer ID 签名并通过 Apple 公证。打开 `.dmg`，然后把 Jiran 拖到 Applications。

**Windows：** 安装版和便携版均已签名（[查看验证方法]({{repositoryUrl}}/blob/main/docs/code-signing.md#verify-a-download)）。

**Linux AppImage：** 先给执行权限，然后运行：

```bash
chmod +x Jiran-*.AppImage
./Jiran-*.AppImage
```

**Linux Debian 包：** 双击交给 App Center 安装，或执行 `sudo apt install ./Jiran-{{version}}.deb`。按 [docs/RELEASING.md]({{repositoryUrl}}/blob/main/docs/RELEASING.md) 配好本项目的 APT 源之后，App Center 会把新版本直接显示为可升级。

**Android：** APK 是 Hub 的只读客户端，本身不采集数据，所以需要先有一个 Docker Compose Hub。签名使用长期保存的密钥，安装新版可直接覆盖旧版。

### 其他说明

快捷下载没有列出的平台不提供预构建版本，请参考 [README]({{repositoryUrl}}#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包，除非明确需要，否则可以忽略。

### tokscale 依赖

Tokscale 已随应用内置，版本随本应用一起构建与更新，无需单独安装。Tokscale 是 MIT 开源项目：
https://github.com/junhoyeo/tokscale

</details>

<!-- release-hub-image -->
