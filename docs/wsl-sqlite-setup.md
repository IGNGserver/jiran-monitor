# WSL SQLite usage setup

[简体中文](wsl-sqlite-setup.zh-CN.md)

## When this setup is needed

On Windows, Jiran normally scans supported tools inside every running WSL distribution through `\\wsl$` and merges their usage about every five minutes. File-based sources such as Codex JSONL sessions work well with this path.

SQLite-backed tools such as OpenCode, Hermes, and ZCode store current usage in SQLite databases. A Windows process can discover those databases through `\\wsl$` while SQLite still cannot reliably coordinate locks or an active WAL across the WSL 9P boundary. Jiran's built-in scan therefore reports the distro as reached — the **WSL status** block on the Devices view — while those tools contribute no usage.

Do not copy a live `.db` file as a workaround. Recent transactions may still be in `-wal`, and copying the database and sidecars separately does not guarantee a consistent snapshot.

The reliable setup is:

```text
WSL headless agent → Windows Docker Compose Hub → Jiran desktop app
```

The agent runs the Linux tokscale binary next to the database, then sends only the normalized usage summary to the hub.

## 1. Start the Docker Compose Hub on Windows

On the Windows machine that will stay online, deploy the repository's root Compose stack:

```bash
cp .env.example .env
# set JIRAN_SECRET, MYSQL_PASSWORD, and MYSQL_ROOT_PASSWORD
# WSL is remote from the Hub: explicitly select trusted-LAN HTTP,
# or use the HTTPS profiles in docs/hub-compose.md instead.
# JIRAN_BIND_HOST=0.0.0.0
# JIRAN_ALLOW_INSECURE_HTTP=1

docker compose up -d
curl http://127.0.0.1:17321/api/health
```

Use the same `JIRAN_SECRET` on the Hub and the WSL agent. Keep the Hub on a trusted network and retain the key. If WSL cannot reach the Windows hostname, use the Windows host IP while keeping the same port, which defaults to `17321`.

## 2. Install the headless agent in WSL

Jiran requires Node.js 22.13.0 or newer. Verify Node.js and npm inside WSL before installing; upgrade Node.js first if the reported version is older.

```bash
node --version
npm --version
git clone https://github.com/IGNGserver/jiran.git
cd jiran
npm ci --omit=dev
```

Create `.env` at the project root:

```env
JIRAN_HUB_URL=http://WINDOWS_HOST_IP:17321
JIRAN_SECRET=YOUR_HUB_SECRET
JIRAN_DEVICE_ID=wsl-agent
JIRAN_ALLOW_INSECURE_HTTP=1
```

`JIRAN_DEVICE_ID` must differ from the Windows desktop app device ID. The hub treats matching IDs as the same device, so a duplicate ID would make the latest post replace the previous record.

`YOUR_HUB_SECRET` must be the same single key configured on the Hub. The
insecure-HTTP opt-in is only for a trusted LAN/VPN. Prefer an HTTPS Hub when
available.

## 3. Choose one collection boundary

The hub adds device totals; it does not deduplicate the same session across devices. Both collectors now track every supported tool, so the boundary is the machine, not the client id:

- Recommended: let the WSL agent own WSL usage, and turn off the Windows-side WSL scan by setting `JIRAN_WSL_SCAN=0` for the desktop app (the same key in `settings.json`; the old Settings toggle is gone).
- Alternative: skip the agent and keep the built-in Windows `\\wsl$` scan. Codex/Claude-style JSONL sessions are read that way, but SQLite-backed tools inside WSL (OpenCode, Hermes, ZCode) are not.

Do not run both collectors against the same WSL home: they would report every tool twice. Client-level narrowing (`JIRAN_CLIENTS`) no longer exists.

## 4. Verify and keep it running

Send one snapshot first:

```bash
npm run agent:once
```

Confirm that a second device appears in Jiran and that the SQLite-backed tool has usage. Then run the continuous agent:

```bash
npm run agent
```

For unattended use, run that command from your normal WSL service manager or login startup. Keep its working directory set to the Jiran checkout so `.env` is loaded.

## Troubleshooting

- **No second device:** verify the hub URL, that `JIRAN_SECRET` matches the Hub's single key, the insecure-HTTP opt-in when applicable, and Windows firewall access to the hub port.
- **Request goes through a proxy:** add the Windows host IP to `NO_PROXY` and `no_proxy`, or unset the proxy variables for the agent process.
- **Totals are doubled:** turn off the Windows desktop app's built-in WSL scan (`JIRAN_WSL_SCAN=0` for the desktop process). Client-level narrowing is gone, so the two collectors must be split by machine.
- **The WSL status block still reports no usage for a tool:** that status describes the Windows-side `\\wsl$` scan only. The WSL agent appears as a separate synced device and is the authoritative source for these SQLite-backed tools.
