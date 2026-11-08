# Jiran Hub — canonical Docker Compose deployment

This is the only supported Hub deployment. Pull the published Hub image from GitHub Container Registry and run it with MySQL.

## Requirements

- Docker Engine + Docker Compose v2
- Outbound access to `ghcr.io` and Docker Hub (`mysql`)

## Quick start

```bash
cp .env.example .env
# edit .env: JIRAN_SECRET, MYSQL_PASSWORD, MYSQL_ROOT_PASSWORD
# optional: JIRAN_VERSION=0.47.0  (default: latest)

docker compose pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:17321/api/health
```

Open `http://127.0.0.1:17321` on the Hub host. The default configuration binds both the Hub and the published Docker port to loopback, so it neither exposes plaintext HTTP nor needs the insecure-transport override.

## Choose a remote-access transport

Remote clients need one of the following explicit profiles. Run `docker compose up -d` again after changing `.env` or an override file. Existing remote deployments that previously relied on the old all-interface default must set `JIRAN_BIND_HOST=0.0.0.0` when recreating the container.

`JIRAN_BIND_HOST` is the address Docker **publishes** on, and that is the exposure boundary: it defaults to `127.0.0.1`. Inside the container the Hub always listens on `0.0.0.0`, because Docker forwards the published port to the container address — a loopback listener there would be unreachable. The `insecure_hub_transport` guard still applies when the Hub binary is run directly, but a Compose deployment sets the container-internal plaintext flag itself.

### Same-host HTTPS reverse proxy (recommended)

Keep `JIRAN_BIND_HOST=127.0.0.1`. Terminate public HTTPS in a reverse proxy on the same host and proxy to `http://127.0.0.1:17321`; clients use only `https://hub.example.com`. A minimal nginx location is:

```nginx
location / {
    proxy_pass http://127.0.0.1:17321;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Required for the Hub's SSE stream.
    proxy_buffering off;
}
```

Set `JIRAN_TRUST_PROXY=1` only when this trusted proxy is the only route to the Hub and overwrites forwarded headers. Do not expose the loopback port through another firewall publish rule.

### Direct Hub TLS

Generate or install a certificate valid for the Hub hostname, then create `docker-compose.override.yml` beside the base file:

```yaml
services:
  hub:
    volumes:
      - ./certs:/certs:ro
```

Set the following in `.env` and recreate the container:

```dotenv
JIRAN_BIND_HOST=0.0.0.0
TOKEN_MONITOR_TLS_CERT=/certs/hub.crt
TOKEN_MONITOR_TLS_KEY=/certs/hub.key
```

Clients use `https://hub.example.com:17321`. Restrict the published port with the host firewall to the networks that need it. The external-database Compose file uses the same bind and TLS variables and accepts the same override.

### Trusted LAN/VPN plaintext HTTP (explicit exception)

Use this only on an access-controlled trusted LAN or VPN, never on a public interface. Publishing beyond loopback is the explicit decision for a Compose deployment; keep the host firewall rule in front of the port:

```dotenv
JIRAN_BIND_HOST=0.0.0.0
```

Clients use `http://<server>:17321`. Running the Hub binary directly instead of Compose additionally needs `JIRAN_ALLOW_INSECURE_HTTP=1`, or startup fails with `insecure_hub_transport`; Compose sets the container-internal equivalent itself. Restrict the port to trusted source addresses at the host/network firewall. This is a transport exception, not an authentication bypass: `JIRAN_SECRET` remains required for a non-loopback Hub. Prefer HTTPS whenever clients include mobile devices or the network is not fully controlled by you.

## Container runtime

The Hub image runs as the unprivileged `node` user (uid 1000) and binds an unprivileged port, so both Compose files start it with `cap_drop: ALL`, `read_only: true`, a `/tmp` tmpfs and `no-new-privileges`. The process writes nothing else: configuration, accounts and credentials live in MySQL, and the web bundle is read-only.

Two consequences for operator-supplied files:

- Mounted TLS material must be readable by uid 1000 — `chmod 644` for certificates and `640` with the group owner set to 1000 for private keys. A `600 root:root` key fails startup with a read error rather than silently serving plaintext.
- A provider probe may stage a temporary directory under `/tmp`, which the tmpfs provides. Do not remove the tmpfs entry; if a future integration needs a durable writable path, mount it explicitly instead of making the root filesystem writable.

If a local override genuinely requires writes (for example a custom image that persists files under `/app`), override the hardening for that service alone rather than dropping it from the base files:

```yaml
services:
  hub:
    read_only: false
    tmpfs: []
```

## Versions

| Value | Meaning |
|---|---|
| `latest` (default) | Newest formal release image |
| `0.47.0` | Pin a specific release (recommended for production) |
| `v0.47.0` | Same image, tag with `v` prefix |

Image: `ghcr.io/igngserver/jiran-hub`

> 项目已从 Token Monitor 改名为 计然 / Jiran。过渡期内 `ghcr.io/igngserver/token-monitor-hub`
> 仍会被推送完全相同的标签，现有部署不改镜像名也能继续升级；建议尽快改成 `jiran-hub`。

## External MySQL (shared or remote server)

The quick start above runs MySQL inside this Compose project. If the machine
already runs a database server — or several Docker apps should share one — start
only the Hub instead:

```bash
# .env
JIRAN_DATABASE_URL=mysql://jiran:your-password@db.example.lan:3306/jiran
# optional TLS:
# JIRAN_DATABASE_SSL=required
# JIRAN_DATABASE_SSL_CA=/certs/ca.pem

docker compose -f docker-compose.external-db.yml up -d
```

`JIRAN_DATABASE_URL` wins over `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` /
`MYSQL_PASSWORD` / `MYSQL_DATABASE`; pool sizing still comes from the
`MYSQL_*` knobs. Percent-encode special characters in the password
(`@` → `%40`, `$` → `%24`). A local socket is `?socket=/run/mysqld/mysqld.sock`.
The URL is never logged; startup prints the redacted target
(`mysql://user@host:3306/database`).

**One database per Hub.** The fleet read model lives in the Hub process, so two
Hub processes must never share a schema — the second one would serve a stale
fleet. Sharing a *server* is supported: each Hub gets its own database, its own
user, and (because `GET_LOCK` is server-wide) a migration lock scoped by database
name.

```sql
CREATE DATABASE jiran CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'jiran'@'%' IDENTIFIED BY '...';
GRANT ALL PRIVILEGES ON jiran.* TO 'jiran'@'%';
```

Supported server: **MySQL 8.0 or newer**. MariaDB and MySQL 5.7 are rejected at
startup — the schema uses `utf8mb4_0900_ai_ci`, `JSON_SET` and `DATETIME(3)`.
Managed MySQL services must allow `GET_LOCK` for migrations.

### Connection budget

Every app on the server multiplies its own pool. For N Hubs and other clients:

```
N × MYSQL_CONNECTION_LIMIT + other clients < MySQL max_connections
```

`MYSQL_MAX_IDLE` (default 2) and `MYSQL_IDLE_TIMEOUT_MS` (default 30 s) keep an
idle Hub from holding a full pool open. The external-db Compose file defaults
`MYSQL_CONNECTION_LIMIT` to 5.

### Latency

Reads are served from the in-process fleet model after the first load; the
remaining remote-database cost is the per-ingest write (about eight round trips,
down from 11–14) and the initial fleet load. The round-trip budget, the rejected
cache options and the reproduction procedure are in
[performance/remote-database.md](performance/remote-database.md). Measure before
tuning:

- `GET /api/health` reports `storage.latencyMs` and answers **503** when MySQL is
  unreachable, so `docker compose ps` shows unhealthy instead of "running".
- `MYSQL_SLOW_QUERY_MS` (default 1000, `0` disables the log) prints the SQL text
  (never bound values) of slow statements.
- The Hub retries transient connection failures during startup/migrations with a
  bounded backoff, so a remote server that starts later does not crash-loop it.

For a slow link, prefer a database near the Hub, keep `MYSQL_CONNECTION_LIMIT`
small, and avoid pointing several Hubs at one schema (see above).

## Upgrade

```bash
# follow latest
docker compose pull
docker compose up -d

# or pin
# JIRAN_VERSION=0.47.0 docker compose pull
# JIRAN_VERSION=0.47.0 docker compose up -d
```

Do **not** run `docker compose down -v` — that deletes the MySQL data volume.

## Gemini quota renewal

Google's OAuth token endpoint requires a client id **and** secret to redeem a
refresh token, so automatic renewal for a Gemini Code Assist account needs an
OAuth client of your own. This project deliberately ships neither — Google's own
client belongs to the `gemini-cli` project, and bundling it would make every
install authenticate as someone else's application.

Register a client (type **Desktop app**) in Google Cloud, then set both values in
`.env` and recreate the container:

```bash
GEMINI_OAUTH_CLIENT_ID=...apps.googleusercontent.com
GEMINI_OAUTH_CLIENT_SECRET=...
docker compose up -d
```

Set this on the **Hub**, not the desktop app: the probe runs server-side. A
pasted access token needs none of this (it is used as-is, and simply expires);
without the pair a refresh-token account reports *not configured* rather than
failing ambiguously.

## First GHCR pull note

If the package is private on a fresh org, set the package visibility to **Public** under
GitHub → Packages → `jiran-hub` → Package settings.
Public repos usually expose public packages after the first release push.
