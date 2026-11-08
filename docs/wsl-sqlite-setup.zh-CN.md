# WSL SQLite 用量配置指南

[English](wsl-sqlite-setup.md)

## 什么时候需要这样配置

Windows 版计然默认会通过 `\\wsl$` 扫描所有正在运行的 WSL 发行版，并约每五分钟合并一次用量。Codex JSONL session 这类文件型数据通常可以直接读取。

OpenCode、Hermes 和 ZCode 等工具的当前用量保存在 SQLite 数据库中。Windows 进程可以通过 `\\wsl$` 找到数据库，但 SQLite 无法可靠地跨 WSL 9P 边界协调文件锁和正在使用的 WAL。因此，计然的内建扫描会在设备视图的 **WSL 状态** 中报告已连上该发行版，但这些工具不会贡献任何用量。

不要把复制正在使用的 `.db` 文件当作解决方案。最新事务可能还在 `-wal` 中，而分别复制数据库与 sidecar 文件也无法保证得到一致快照。

可靠的架构是：

```text
WSL headless agent → Windows Docker Compose Hub → 计然桌面端
```

Agent 在数据库旁边运行 Linux 版 tokscale，再把规范化后的用量摘要发送给 hub。

## 1. 在 Windows 启动 Docker Compose Hub

在准备长期运行的 Windows 机器上部署仓库根目录的 Compose 服务：

```bash
cp .env.example .env
# 设置 JIRAN_SECRET、MYSQL_PASSWORD 和 MYSQL_ROOT_PASSWORD
# WSL 对 Hub 来说是远端：显式选择可信 LAN 明文 HTTP；
# 更推荐改用 docs/hub-compose.md 中的 HTTPS 配置。
# JIRAN_BIND_HOST=0.0.0.0
# JIRAN_ALLOW_INSECURE_HTTP=1

docker compose up -d
curl http://127.0.0.1:17321/api/health
```

Windows Hub 和 WSL agent 使用同一个 `JIRAN_SECRET`。请只在可信网络中开放 Hub 并保留密钥。如果 WSL 无法访问 Windows 主机名，请改用 Windows 主机 IP，端口保持不变，默认是 `17321`。

## 2. 在 WSL 安装 Headless Agent

计然需要 Node.js 22.13.0 或更高版本。安装前请先在 WSL 内检查 Node.js 与 npm；如果 Node.js 版本过低，请先完成升级。

```bash
node --version
npm --version
git clone https://github.com/IGNGserver/jiran.git
cd jiran
npm ci --omit=dev
```

在项目根目录创建 `.env`：

```env
JIRAN_HUB_URL=http://WINDOWS_HOST_IP:17321
JIRAN_SECRET=Hub_的单一密钥
JIRAN_DEVICE_ID=wsl-agent
JIRAN_ALLOW_INSECURE_HTTP=1
```

`JIRAN_DEVICE_ID` 必须与 Windows 桌面端的设备 ID 不同。Hub 会把相同 ID 当作同一台设备，后发送的记录会覆盖前一条。

`JIRAN_SECRET` 必须与 Hub 上配置的单一密钥一致。仅当 Hub 位于可信
LAN/VPN 且暂时无法启用 HTTPS 时，才使用上述明文 HTTP 开关。

## 3. 明确采集边界

Hub 会直接相加不同设备的总量，不会跨设备去重同一个 session。现在两个采集器都会采集全部受支持工具，所以要按「机器」划分边界，而不是按客户端 id 缩小范围：

- 推荐：让 WSL agent 负责 WSL 用量，并把 Windows 桌面端的内建 WSL 扫描关掉（`JIRAN_WSL_SCAN=0`，桌面端读同一个 `settings.json` 键；旧设置界面里的开关已移除）。
- 另一种方式：不运行 agent，只保留 Windows 侧内建的 `\\wsl$` 扫描。这样可以读到 Codex / Claude 这类 JSONL session，但 WSL 内基于 SQLite 的工具（OpenCode、Hermes、ZCode）读不到。

不要让两个采集器扫描同一个 WSL home，否则每种工具都会被上报两次。按客户端缩小的配置（`JIRAN_CLIENTS`）已不存在。

## 4. 验证并持续运行

先发送一次快照：

```bash
npm run agent:once
```

确认计然中出现第二台设备，并且 SQLite 工具有用量。然后启动持续运行的 agent：

```bash
npm run agent
```

如需无人值守运行，请通过你平时使用的 WSL 服务管理器或登录启动项执行该命令，并把工作目录设为计然 checkout，确保 `.env` 会被加载。

## 排查

- **没有出现第二台设备**：检查 Hub URL、`JIRAN_SECRET` 是否与 Hub 的单一密钥一致、必要时的明文 HTTP 开关，以及 Windows 防火墙是否允许访问 hub 端口。
- **请求被代理拦截**：把 Windows 主机 IP 加入 `NO_PROXY` 与 `no_proxy`，或为 agent 进程取消代理环境变量。
- **总量重复**：关闭 Windows 桌面端的内建 WSL 扫描（桌面进程设置 `JIRAN_WSL_SCAN=0`）。按客户端缩小范围已不可用，只能按机器划分两个采集器。
- **WSL 状态仍报告无用量**：该状态只描述 Windows 侧自己的 `\\wsl$` 扫描。WSL agent 会作为另一台同步设备出现，并作为这些 SQLite 工具的权威来源。
