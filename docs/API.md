# API

The hub exposes a JSON HTTP API and serves a same-origin web dashboard (PWA) from the hub root (`/`). Static UI assets and `/api/health` are public; private API routes require the single owner's credential. Remote connections use HTTPS by default. Docker Compose Hub/agent/desktop require `JIRAN_ALLOW_INSECURE_HTTP=1` for an intentional non-loopback HTTP deployment. The Android client supports the same intentional LAN/VPN plain-HTTP Hub behind an explicit opt-in: the platform permits cleartext (so the OS does not silently contradict the in-app switch), while `HubApiFactory` rejects a non-HTTPS URL unless that switch is on. User-installed CAs are trusted in debug builds only.


For pricing refreshes, the Hub invokes `tokscale pricing <model> --json` first. If tokscale cannot complete its upstream catalog request, the Hub retries against the configured `TOKSCALE_PRICING_CATALOG_URL` (default `https://models.dev/api.json`), which is a public catalog tokscale also uses. The catalog is cached in the Hub process for six hours; the resulting `model_pricing` row remains durable.

## Authentication

For the single-user deployment, configure one key:

- `JIRAN_SECRET`: shared by the Hub and every desktop app / agent. It grants read, ingest, and every administrative mutation, including manually managed Hub accounts.

Old split admin/viewer/device variables are not accepted as alternate users. Existing deployments must migrate to `JIRAN_SECRET`; a configured owner key always has every product capability.
`JIRAN_HUB_CREDENTIAL_KEY` remains an optional override for encrypting manually added Hub account credentials at rest.

An unconfigured Docker Compose Hub is restricted to loopback. A remote Hub refuses all private routes until at least one unified or split credential is configured.

Use either:

```http
Authorization: Bearer <secret>
```

or:

```http
X-Jiran-Secret: <secret>
```

The historical `X-Jiran-Secret` header is still accepted so devices that predate the 计然 / Jiran rename keep working against a renamed Hub.

Credentials in query strings are rejected. Secrets can appear in browser, proxy, CDN, or diagnostic logs, so clients must send the owner key in a header.

The Hub rate-limits repeated authentication failures per source and ingest bursts per authenticated principal. Successful administrative mutations emit structured `[hub-audit]` records containing the time, principal ID, action, and target; secret values are never logged.

## `GET /api/health`

Health check. Does not require authentication.

Example response:

```json
{
  "ok": true,
  "role": "hub",
  "version": 1,
  "apiVersion": 3,
  "capabilities": {
    "stats": true,
    "history": true,
    "statsStream": true,
    "subscriptions": true,
    "usageRange": true,
    "pricing": true,
    "deviceDelete": true,
    "deviceRename": true,
    "publicStats": false,
    "hubAccounts": true,
    "centralLimits": true,
    "limitsAuthority": "hub"
  },
  "deviceCount": 2,
  "secretRequired": true,
  "now": "2026-05-18T00:00:00.000Z"
}
```

`version` remains `1` for compatibility. `apiVersion` versions the capability/authentication contract. The Docker Compose Hub exposes the full capability set shown above.

## `GET /api/capabilities`

Requires the owner key and returns the server feature set plus `authenticated: true`. Clients use this endpoint to validate a saved token; feature availability is described by `capabilities`, not user roles.

```json
{
  "apiVersion": 3,
  "capabilities": { "stats": true, "usageRange": true, "pricing": true },
  "authenticated": true
}
```

Staged reads are advertised as `statsSummary`, `deviceDetail`, and `sessionList`
(see `GET /api/stats/summary`). They are additive: a Hub that omits them has only
`/api/stats`, so a client must treat absence as "not available" and fall back
rather than call an endpoint that may not exist.

## `POST /api/ingest`

Posts one device usage summary.

Requires the owner key. The `deviceId` identifies the data source, not a separate user. Reposting an unchanged cumulative snapshot is idempotent: the Hub derives zero ledger delta and replaces the same current record.

First-party agents send `Prefer: return=minimal` and receive only
`{"ok":true,"deviceId":"..."}`. This avoids aggregating and returning the full
multi-device snapshot when no SSE consumer needs it. For compatibility, callers
that omit the header still receive the legacy `stats` field; when SSE consumers
are connected, the Hub computes one snapshot and reuses it for the broadcast.

Example payload:

```json
{
  "deviceId": "macbook",
  "hostname": "macbook.local",
  "platform": "darwin-arm64",
  "osName": "macOS",
  "osVersion": "26.0",
  "updatedAt": "2026-05-18T00:00:00.000Z",
  "agentVersion": "0.3.0",
  "agentRuntime": "headless-agent",
  "syncUploadIntervalMs": 1200000,
  "projectsEnabled": true,
  "trackedClients": ["codex"],
  "today": {
    "totalTokens": 1234,
    "costUsd": 0.01,
    "cacheReadTokens": 1100,
    "cacheWriteTokens": 0,
    "outputTokens": 34,
    "clients": {
      "codex": 1234
    },
    "clientCosts": {
      "codex": 0.01
    },
    "clientCredits": {},
    "clientCacheReads": {
      "codex": 1100
    },
    "clientCacheWrites": {
      "codex": 0
    },
    "clientOutputs": {
      "codex": 34
    },
    "models": {
      "gpt-5": 1234
    },
    "modelCosts": {
      "gpt-5": 0.01
    },
    "modelCacheReads": {
      "gpt-5": 1100
    },
    "modelCacheWrites": {
      "gpt-5": 0
    },
    "modelOutputs": {
      "gpt-5": 34
    },
    "clientModels": {
      "codex": {
        "gpt-5": 1234
      }
    },
    "clientModelCosts": {
      "codex": {
        "gpt-5": 0.01
      }
    },
    "sessions": {
      "codex:rollout-2026-05-30T11-44-50-abc": {
        "client": "codex",
        "sessionId": "rollout-2026-05-30T11-44-50-abc",
        "totalTokens": 1234,
        "costUsd": 0.01,
        "messageCount": 3,
        "inputTokens": 100,
        "outputTokens": 34,
        "cacheReadTokens": 1100,
        "cacheWriteTokens": 0,
        "reasoningTokens": 0,
        "startedAt": "2026-05-30T03:44:50.000Z",
        "lastUsedAt": "2026-05-30T04:07:32.679Z",
        "projectId": "sha256:opaque-project-identifier",
        "projectLabel": "token-monitor",
        "models": {
          "gpt-5": 1234
        },
        "modelCosts": {
          "gpt-5": 0.01
        },
        "providers": {
          "openai": 1234
        }
      }
    }
  },
  "month": {
    "totalTokens": 4567,
    "costUsd": 0.04,
    "clients": {},
    "clientCosts": {},
    "clientCredits": {}
  },
  "allTime": {
    "totalTokens": 8901,
    "costUsd": 0.08,
    "clients": {},
    "clientCosts": {},
    "clientCredits": {},
    "projects": {
      "token monitor": {
        "label": "Jiran",
        "tokens": 8901,
        "costUsd": 0.08,
        "clients": { "codex": 8901 }
      }
    }
  },
  "periodWindows": {
    "today": { "key": "2026-05-18", "endsAt": "2026-05-19T00:00:00.000Z" },
    "month": { "key": "2026-05", "endsAt": "2026-06-01T00:00:00.000Z" }
  }
}
```

The hub normalizes records before storing them. The Node hub accepts JSON ingest bodies up to 1 MiB; larger bodies return `413 payload_too_large`.

Device `limits` and `limitsOnly` fields are accepted only for mixed-version
compatibility and are discarded before persistence. Devices and agents do not
probe or report local provider accounts. Quota data shown by `/api/stats` is
owned by the Hub account service.

The MySQL Node hub stores each change between a device's cumulative all-time snapshots in an append-only `usage_events` ledger. A row records the time that the difference was recorded (`recorded_at`), not an individual provider API request time. The synchronized protocol intentionally omits unbounded `allTime.sessions`; in that case the hub uses a `snapshot:<client>:<model>` session id to preserve the client/model aggregate without implying an original conversation id. Counter resets never produce negative events: the newly reported cumulative value is recorded as the start of a new counter cycle.

`projects` is a bounded rollup keyed by a canonicalized workspace-folder label. Each entry carries the deterministic display `label`, token/cost totals, and a per-client token breakdown. Agents upload `allTime.projects` because synchronized payloads intentionally omit the unbounded `allTime.sessions`; `today.projects` and `month.projects` are normally omitted on upload and rebuilt by the hub from their synchronized sessions. If adding the all-time rollup would exceed the safe ingest budget, the agent drops only that rollup, sets `allTimeProjectsOmitted: true`, and keeps core totals and session data uploadable. If monthly or daily session detail would still exceed the budget, the agent keeps the newest rows that fit, sends the complete project rollup for that period, and sets `sessionDetailsOmitted` to the number of omitted rows per affected period. If that project rollup cannot fit even after all session rows are removed, the agent omits it too and sets `periodProjectsOmitted`; token/cost and client/model totals remain complete while the affected project breakdown is marked incomplete. A normal later upload clears these diagnostics; limits-only updates preserve them. `projectsEnabled: false` tells the hub that project metadata collection is disabled for this device; sync payloads then remove project rollups plus session `projectId` / `projectLabel` fields.

Authenticated stats expose `projectsIncomplete: true` when a device omitted its rollup, disabled project tracking while contributing usage, or could not preserve exact all-time attribution after its tracked-client list changed. Affected device entries expose `allTimeProjectsOmitted`, `allTimeProjectsIncomplete`, or `projectsEnabled: false` as the reason.

`trackedClients` is optional but recommended for agents and the desktop app. When it is present, the hub treats omitted clients as intentionally not collected in this payload and preserves their previous usage for that device. This keeps "tracking" as "collect future data" rather than "hide existing history". Current desktop and agent builds always send the complete tracked set — every supported tool is collected, and the field is a producer-side manifest — so the preservation rule now exists for third-party or older producers that still send a subset.

Current agents and the desktop app include `osName` and, when known, `osVersion` so device details can show a user-facing operating-system release. macOS uses the product version from Electron or `sw_vers`; Windows uses the product family and display version from the registry; Linux uses the distribution name and version from `os-release`. Detection failures fall back to an explicitly labelled Windows build or Linux kernel release. The hub continues to accept older payloads without these fields.

`syncUploadIntervalMs` is optional. A remote-hub desktop app or headless agent includes `0` for live uploads or the selected fixed interval in milliseconds (`600000`, `1200000`, or `1800000`). The hub uses a positive interval to keep the device and its limits fresh for at least twice the upload interval; omitted or `0` values retain the configured `staleAfterMs` behavior. Local collection remains independent of upload cadence.

`periodWindows` is optional. Agents and the desktop app stamp each snapshot with the UTC instant its `today`/`month` windows end, computed in the device's own local time (`endsAt` = next local midnight / next local month start; `key` is the device-local day/month for reference), plus the IANA `timeZone` that produced the keys when the host can resolve one (a payload that omits it is still accepted). The hub uses `endsAt` to expire a device's `today`/`month` from both the aggregate and the per-device view once `now >= endsAt`, so a device that goes offline before re-posting does not keep contributing or displaying a stale day/month snapshot (`allTime` never expires). Payloads without `periodWindows` fall back to a UTC day/month comparison against `updatedAt`.

`limits` is optional for mixed-version compatibility but is ignored by current device ingest. AI Tool Limits are owned and refreshed by the Hub account service; current agents and the desktop app do not probe local provider accounts or upload credentials. Raw OAuth credentials, access tokens, refresh tokens, and provider response bodies must never be sent.

`limits.providers[].provider` is one of `claude`, `codex`, `opencode`, `cursor`, `antigravity`, `kimi`, `grok`, `copilot`, `commandcode`, `mimo`, `zai`, `zaiteam`, `kiro`, `qoder`, `deepseek`, `openrouter`, `minimax`, `volcengine`, `ollama`, or `thirdparty`.
`limits.providers[].accountKey` is a stable hashed account identifier (`sha256:…`) used to dedupe the same account across devices. `accountEmail` is the account email when available, and `accountName` is a sanitized display/profile name. Codex may additionally send `workspaceKind: "personal"` when the workspace has no provider-supplied name, allowing account-management UI to localize the Personal label without persisting translated text. `accountLabel` is the legacy provider-defined short label retained for mixed-version compatibility: older OpenCode renderers use it as the profile name, while existing providers may use it for the plan. `planLabel` is the explicit plan label (for example `Plus`, `Go`, or `Zen`) when identity and plan must be carried separately; readers fall back to `accountLabel` for payloads produced before `planLabel` existed. These fields MAY be sent to the authenticated hub so devices can identify each account and its plan. Hub ingest requires an admin, explicitly elevated legacy, or device-bound credential; the **public** stats endpoints (`publicLimits`) strip `accountKey`, `accountEmail`, `accountName`, `accountLabel`, `planLabel`, and `workspaceKind` so neither account identity nor plan labels are exposed publicly.
`limits.providers[].source` is one of `oauth`, `cli`, `web`, `rpc`, `local`, or `api`; it describes how the Hub-side provider probe obtained the result. It does not imply that a device discovered or uploaded a local account.
`limits.providers[].credentialOrigin` is `manual` for accounts created through the Hub account API. `automatic` is retained only for mixed-version records and must not be produced by the new device path.

Local usage adapters share one collector contract: they expose client ids, source capabilities, range/history support, optional native meters, watch roots, source fingerprints, and bounded diagnostics. Qoder keeps its three-source parser behind that contract; its Global and CN clients remain separate because their profiles are separate. Windows WSL homes use the same Qoder adapter against the Linux home rather than sending Qoder ids to tokscale. WSL session days are bucketed in the **Windows host** timezone, because the scanner (`tokscale`) runs as a Windows process; a distro whose own `TZ` differs from Windows will still report against the host's calendar, consistently with the host-native clients on the same device.
`limits.providers[].balanceUsd` is an optional prepaid credit balance in USD (OpenCode Zen); `null` when the provider has no balance concept or none could be read. A genuine `0` (no remaining credit) is distinct from `null`.
`limits.providers[].balance` is an optional native-currency prepaid balance block. DeepSeek uses `{ amount, currency, todaySpend, monthSpend, allTimeSpend, trackingSince, monthSinceTracking }`: `amount` is the spendable balance in the account's own currency (e.g. `CNY`/`USD`); the spend fields are derived from locally observed paid-balance drawdown, `allTimeSpend` keeps accumulating after old daily buckets are pruned, `trackingSince` records when that local observation began, and `monthSinceTracking` is `true` until a full month of history has accrued. OpenRouter uses USD: `/key` supplies `todaySpend`, `weekSpend`, `monthSpend`, and the provider-reported lifetime `allTimeSpend`; when OpenRouter authorizes `/credits` (officially documented for Management keys), `amount` and the corresponding real Credits meter are also included. Other API keys can still report their own spend and configured key limit without inventing an account balance. MiMo may additionally send `giftBalance`, `cashBalance`, Token Plan usage fields, and `planStatus` (`active`, `expired`, `none`, or `null`). An expired MiMo Token Plan has no quota window even when its prepaid balance remains available. `null` when not applicable. DeepSeek uses `source: "api"` with an empty `windows` array (it has no rate-limit windows). OpenRouter, GLM/Z.ai, Volcengine, Qoder, Kimi, and Ollama report quota/credit windows through the same `windows` array.
`windows[].kind` is `session`, `weekly`, `billing`, `named`, or `credits`. `named` marks an allowance that is metered separately from the plan cadence and therefore carries its own bounded `label` (Codex's Luna Reserve and Spark allowances, code review, per-account individual spend limits); `credits` is a purchased credit pool reported as an absolute `remaining` amount without a percentage, because the provider never reports its maximum. `windows[].metric` is an optional stable machine-readable role; `credits` identifies the OpenRouter account-credits meter independently of its display label. `windows[].detail` is an optional bounded display-only description for a window, such as the Kimi-vs-Code composition of the single shared monthly membership meter; it must not contain credentials or raw provider response data.

Qoder usage is always tracked as two independent clients: `qodercn` for the China site (`~/.qoder-cn`, app support `QoderCN`) and `qoder` for the international site (`~/.qoder`, app support `Qoder`). Both are read by one adapter with three sources — the legacy SQLite database, the desktop `main.sqlite` message store, and the Claude-Code-style transcript tree — and any of them may contribute to a record. Main-database and transcript-derived periods, sessions, and costs carry `estimated: true` because those sources do not expose exact provider token billing. Both sites list `com.qoder.app.stable` as a `main.sqlite` candidate, so that directory is read only when the claiming site's own footprint (app-support or profile directory) is present; one installer's messages are never billed to the other client.
The transcript tree is the exception to that blanket estimate: Qoder publishes a per-request `credits` meter there (alongside `original_credits` and a `billable` flag) while leaving `input_tokens`, `output_tokens` and both cache fields at `0`, so the credit total reported in `periods.*.clientCredits` is exact and is not covered by the `estimated` flag. Only the transcript source carries it; a device whose usage came entirely from the SQLite sources reports no entry for that client rather than a zero.

`qoderDiagnostics` is an optional, bounded, non-secret map keyed by tracked client id (`qodercn`, `qoder`). Each entry reports that site's source selection, candidate/read counts, byte/event counts, last-data time, truncation, fallback, and stable failure codes. `qoderCnDiagnostics` is retained as the `qodercn` entry of that map so existing consumers keep working, but a device running both installers must be read through `qoderDiagnostics` — one field can only describe one site. Neither field ever contains transcript paths, content, cookies, account credentials, or session identifiers.

## `GET /api/stats`

Returns aggregate stats for the dashboard and desktop client.

Response includes:

- `staleAfterMs`, the effective Hub threshold used to recompute device and provider freshness
- `periods.today`
- `periods.month`
- `periods.allTime`
- `periods.*.clientModels` and `periods.*.clientModelCosts` for preserving model breakdowns when a tracked tool is disabled
- `periods.*.clientEstimated` is the legacy sparse per-client provenance map behind the `~` marker. New producers also send `periods.*.clientMeasurements`, keyed by client, with `tokens` and `costUsd` provenance (`exact`, `estimated`, or `unknown`) and optional provider-native `meters` such as `{ credits: { value, provenance } }`. Readers should prefer `clientMeasurements` and fall back to the legacy maps; the old period-level `estimated` flag remains for compatibility.
- `periods.*.clientCredits` is the legacy optional per-client map of credits consumed in the provider's own metered unit. New readers should use `clientMeasurements.*.meters`; the legacy field remains for mixed-version devices. Qoder publishes it (`qoder` and `qodercn`), and it is deliberately not folded into `costUsd` / `clientCosts`. Range answers preserve the same measurement metadata when their source supports it; history-only answers may omit native meters because the daily history format has no meter column.
- `periods.*.clientModelCredits` is the same figure at client×model grain, and `sessions.*.credits` / `sessions.*.modelCredits` at session grain. Both are exact rollups of rows the adapter already attributes per session and model — neither splits a client total across the models it used — and they exist so the `usage_events` ledger can store a credit on the same `(client, session, model)` row it already keys on. Only the client-level map is forwarded by the range endpoints; the finer maps have no consumer in a range response yet
- `periods.*.clientMeasurements` is the unified per-client measurement contract. `tokens` and `costUsd` are provenance values (`exact`, `estimated`, or `unknown`); `meters` contains provider-native units with `{ value, provenance }`. `clientEstimated`, `clientCredits`, and `clientModelCredits` remain compatibility fields during the migration.
- `periods.*.projects` for workspace-level tokens, cost, and client attribution; the same canonical folder label aggregates across devices
- `periods.today.sessions` / `periods.month.sessions` keyed by `client:sessionId` for session-level usage when tokscale exposes session groups; clients may use `lastUsedAt` for recent-first sorting and optional `projectId` / `projectLabel` for workspace-level aggregation. Absolute workspace paths stay on the collecting device and are never part of the wire shape. Synchronized clients omit the unbounded `allTime.sessions` collection and may bound `today` / `month` detail when required by the ingest limit while preserving all aggregate totals and breakdowns.
- `sessionDetailsOmitted`, when one or more synchronized devices omitted session rows to stay within the ingest limit; the aggregate contains summed `today` / `month` counts and each affected device reports its own counts
- `periodProjectsOmitted`, when a daily or monthly project rollup was itself too large to fit; the aggregate and affected devices expose omitted project counts and the client marks that period's project breakdown incomplete
- `projectsIncomplete` plus the corresponding `devices[].allTimeProjectsOmitted`, `devices[].allTimeProjectsIncomplete`, or `devices[].projectsEnabled` diagnostic
- `historyPreview.daily[].activeTimeMs`, `historyPreview.monthly[].activeTimeMs`, and `historyPreview.summary.activeTimeMs` when tokscale graph exposes session active-time metrics
- `limits.providers` aggregated by provider account
- `devices`, including each device's normalized `periods`, `receivedAt`, `osName` / `osVersion` when reported, optional `syncUploadIntervalMs`, and optional `periodWindows`; device-level `limits` are not stored or returned
- stale status for devices that have not reported recently

The top-level `limits` object is the Hub-owned account snapshot. Public
stats omit account identifiers. The Hub does not merge device-reported quota
rows because the device protocol does not accept those as authoritative.

Every JSON response is compact (no pretty-printing) and is compressed
(`br`, else `gzip`) when the client sends a matching `Accept-Encoding`. The
response carries `Vary: accept-encoding`; a client that sends none receives the
raw body with a `Content-Length`.

## `GET /api/stats/summary`

Requires the owner key. The first-paint projection of `GET /api/stats`: the same
aggregate and device list, minus the two detail collections a dashboard does not
draw. Every headline number is a reference to the value `/api/stats` already
computed, not a second measurement.

Dropped relative to `/api/stats`:

- `periods.*.sessions`, `devices[].periods.*.sessions` — the session archive
- `devices[].periods.*.projects` — the per-device project rollup
- `devices[].periods.*.clientModels` / `clientModelCosts` — the per-device client×model grain
- `devices[].periods.*.clients` / `clientCosts` / `models` — the per-device breakdown maps
- `devices[].periods.*.clientEstimated` / `clientCredits` / `clientMeasurements` — per-device provenance

Device periods reduce to `totalTokens`, `costUsd`, and an `estimated` flag: the
device list and the comparison chart render a device's totals, and every
breakdown below that is device-detail material served by `GET /api/devices/:id`.

Retained: top-level `periods.*` headline totals and the full client/model/
provenance maps (`clients`, `clientCosts`, `models`, `modelCosts`,
`clientModels`, `clientModelCosts`, `clientEstimated`, `clientCredits`,
`clientMeasurements`, `projects`), every device identity and staleness field,
`limits`, `limitsAuthority`, `historyPreview`, `deviceCount`, and the
`historyRevision` / `deviceHistoryRevision` invalidation tokens.

This is the difference between a first paint measured in tens of kilobytes and
one measured in megabytes on a fleet whose devices retain hundreds of sessions
each. Clients should prefer it when `capabilities.statsSummary` is advertised and
fall back to `/api/stats` otherwise. The dropped detail is reachable through
`GET /api/devices/:id` and `GET /api/sessions`.

## `GET /api/devices/:id`

Requires the owner key. One device's full record, including the session archive
and client×model grain `/api/stats/summary` omits, so a device detail view does
not have to download every other device to render one. Returns
`{ "device": { ... } }` with the same device shape as `stats.devices[]`; an
unknown id returns `404 {"error":"device_not_found"}`. Advertised as
`capabilities.deviceDetail`.

## `GET /api/sessions`

Requires the owner key. The aggregate session list on its own, so
`/api/stats` no longer has to carry it for a screen the user may never open.
Returns `{ total, shown, sessions }`:

- `total` is the number of session rows the Hub holds for the requested periods
- `shown` is the number returned after the display cap (200 rows, newest first
  by `lastUsedAt`); `total > shown` means the list is capped, not complete
- `sessions[]` is the session shape from `periods.*.sessions`, plus a `period`
  field naming where the row came from (`today` / `month` / `allTime`)

The optional `period` query parameter restricts the list to one of those three.
Advertised as `capabilities.sessionList`.

## `GET /api/stats/stream`

Requires the owner key. Server-Sent Events: the Hub pushes an aggregate after
every change, so a client never polls to stay live.

- The first frame is `event: snapshot`, and later frames are `event: stats` with
  `{ type: "stats", reason, stats, at }`. `reason` is one of `ingest`,
  `account-update`, `subscriptions`, `delete`, `rename`, `transfer`, or the
  generic `update`.
- **`?detail=slim` opts into the `/api/stats/summary` projection instead of the
  full `/api/stats` payload.** A frame is re-sent on every ingest broadcast, so
  the full snapshot makes each device's tick cost every subscriber megabytes. The
  slim frame keeps the headline numbers and the `historyRevision` /
  `deviceHistoryRevision` tokens, which is how a client detects that the documents
  the frame omits have moved and re-fetches them (`GET /api/devices/:id`,
  `GET /api/sessions`, `GET /api/history`).
  Without the parameter the stream is unchanged and carries the full document,
  which is what the shared web/desktop renderer reads directly.
- A `: hb` comment line is written on a fixed 30-second cadence purely to keep
  the connection alive; it never queries MySQL.
- Streams are bounded. At capacity the Hub answers `503` with
  `{"error":"too_many_streams"}` and a `Retry-After: 30` header rather than
  evicting an existing viewer.

The response sets `x-accel-buffering: no` and `no-cache, no-transform` so
proxies do not coalesce frames. Behind a reverse proxy, buffer-free delivery
also requires the proxy not to buffer responses (see `JIRAN_TRUST_PROXY`
in [hub-compose.md](hub-compose.md)).

## `GET /api/history`

Requires the owner key. Returns the cross-device history rollup used by the Trends
view: `aggregateHistory()` over every stored device record, so it is the same
shape the desktop app serves locally through its own transport. Only devices
that report the optional `history` field contribute — collection is controlled by
`historyEnabled` in `src/shared/collectorConfig.js` (always on). The optional
`deviceId` query parameter returns history for only that stored device, using
the same response shape; an unknown ID returns an empty history document. This
supports the Trends page's device scope without presenting Hub-wide history as
device-specific data.

The response carries an `ETag` derived from the document's own revision (it is
built entirely from stored records, so the token is a complete identity). A
repeat read with a matching `If-None-Match` is answered `304 Not Modified` with
no body. This is what makes "re-ask for history when the stream's
`historyRevision` moves" cheap for a client that has already fetched it: it
costs a request, not a download.

## `GET /api/subscriptions` / `PUT /api/subscriptions`

`GET` requires the owner key and returns `{ ok, version, subscriptions, updatedAt }`: the
manually recorded plan ledger (plan name, amount, currency, billing cadence,
dates, and the account each record is bound to). Values are typed by the user,
never read from a provider, and stored once per Hub rather than per device.

`PUT` requires the owner key and replaces the whole ledger:

```json
{ "subscriptions": [ ... ], "baseUpdatedAt": "2026-05-18T00:00:00.000Z" }
```

`baseUpdatedAt` makes the write compare-and-swap. When it is older than the
stored revision the Hub answers `409 {"error":"stale_write"}` with the current
document, so two open dashboards cannot silently overwrite each other. An
unknown currency returns `400 {"error":"bad_request"}` and an oversized body
returns `413 {"error":"payload_too_large"}`.

## `GET /api/rates`

No authentication. Returns the display exchange rates the UI uses to render
costs outside USD: `{ ok, rates, date, source }`. `date` is the day the block was
fetched (rates refresh daily), and `source` reports whether the numbers came from
the live provider or the built-in fallback.

## Hub account management

These routes require the owner key. `GET /api/accounts` also requires the owner key
and returns account metadata plus the current normalized quota snapshot; it
never returns the stored credential.

### `GET /api/accounts`

Returns `{ "authority": "hub", "providers": [...], "accounts": [...] }`.
Each account includes its `id`, provider, display fields, status, refresh
timestamps, identity metadata, and `limits`; credential material is omitted. A
record read by the owner also carries `credentialConfigured` (whether a usable
credential is still stored, derived without echoing a value) and, when present,
`credentialMetadata` — the non-secret subset (`accountId`, `endpoint`,
`enterpriseHost`, `site`, `region`, …) a client may display.

### `POST /api/accounts`

Adds a manually supplied account, probes it immediately, encrypts its credential
in the Hub database, and schedules refreshes. Request body:

```json
{
  "provider": "qoder",
  "name": "work",
  "label": "Work account",
  "credential": { "cookie": "<provider credential>" }
}
```

The credential shape is provider-specific and is never echoed in the response.

### `PATCH /api/accounts/:id`

Updates `name`, `label`, or `enabled`. Supplying `credential` replaces the
encrypted credential and performs an immediate probe.

### `POST /api/accounts/:id/refresh`

Performs an immediate Hub-side quota refresh and returns the sanitized account.

### `DELETE /api/accounts/:id`

Deletes the account, its encrypted credential, and its stored quota snapshot.

### `DELETE /api/accounts/:id/credential`

Requires the owner key. Clears the account's stored credential while keeping the
account, its name/label/enabled state, and its identity; the status becomes
`notConfigured` and the published snapshot is emptied. No provider probe runs —
an empty credential can only fail, and turning a deliberate clear into a 4xx
would leave the account in an undetermined state. Use this before re-authorizing
the same account.

### `POST /api/accounts/oauth/start`

Requires the owner key. Begins the Hub-side OAuth sign-in for a provider whose
flow can be completed without a device-local login (`codex`, `antigravity`).

Body: `{"provider":"codex"}`.

Returns `{"ok":true,"sessionId","authUrl","provider"}`. The caller opens
`authUrl` in a browser, completes the provider sign-in, and pastes what the
provider hands back into the exchange call below. The session carries the PKCE
verifier and `state` in memory only and expires after 10 minutes.

### `POST /api/accounts/oauth/exchange`

Requires the owner key. Exchanges the authorization result for a credential,
stores it encrypted, and adds the account in one step — or, when `accountId` is
present, replaces that existing account's credential in place and keeps the
account (`200` instead of `201`). The in-place form is what the edit surface uses,
so re-authorizing a `codex` or `antigravity` account cannot create a duplicate.

Body: `{"sessionId","redirectUrl","name"?,"label"?,"accountId"?}`.

`redirectUrl` is deliberately permissive, because providers hand the user one of
three shapes: a full callback URL, a schemeless URL or bare query string, or a
bare authorization code (Google's Antigravity page shows a code with a copy
button and never puts it in the address bar). Missing `sessionId` or
`redirectUrl` returns `400 {"error":"invalid_params"}`; an unusable paste returns
`400 {"error":"code_missing"}` with a hint naming the accepted shapes.

`name` defaults to a generated `<provider>-<stamp>`; the response is the same
redacted account record as `POST /api/accounts`. A same-identity collision with a
*different* account still returns `account_duplicate`; the edited account's own
identity never conflicts with itself.

## `GET /api/devices`

Returns normalized records for all stored devices.

## `GET /api/pricing`

Returns the currently configured model prices. Each entry has `model`, the four `*PricePerMillion` fields, `source` (`manual` or `tokscale_upstream`), and `updatedAt`.

## `PUT /api/pricing/:model`

Creates or replaces manual pricing for a model. All four non-negative per-million values are required:

```json
{
  "inputPricePerMillion": 2.5,
  "outputPricePerMillion": 10,
  "cacheReadPricePerMillion": 0.25,
  "cacheWritePricePerMillion": 3.75
}
```

## `POST /api/pricing/:model/fetch-upstream`

Runs `tokscale pricing <model> --json`, converts its per-token values to per-million values, and saves the result as `tokscale_upstream`. A model with no upstream pricing returns `422 pricing_not_found`; the hub never silently writes zeroes.

## `POST /api/pricing/fetch-upstream-all`

Fetches upstream pricing for every model observed in the event ledger or current device snapshots. The response lists each model with its individual success or failure result.

When an ingest event has configured pricing, the hub copies those four values, source, timestamp, and computed `costUsd` into the event row. Later changes to `model_pricing` do not alter historical events. Without a configured price, the hub uses the payload's tokscale cost delta and marks the row `pricingSource: "payload_fallback"`.

## `DELETE /api/devices/:id`

Requires the owner key. Removes the device from visible stats. The Node/MySQL Hub keeps its ingest baseline and immutable event ledger as a tombstone, so re-ingesting the same identity does not duplicate historical usage.

## `POST /api/devices/:id/rename`

Requires the owner key. Body: `{"deviceId":"new-id"}`. Atomically moves the current record and measurement identity to the new ID; the Node/MySQL Hub also moves its baseline, ledger, and session rows. Returns `409 target_exists` rather than merging two identities.

For the Docker Compose Hub, device identity is deployment configuration rather than a user credential. Change the client's Device ID, call the rename endpoint, and verify one successful upload before resuming normal collection.

## `POST /api/devices/:id/transfer`

Requires the owner key. Body: `{"targetDeviceId":"existing-id"}`. Moves the source device's entire recorded history onto the target device, which must already exist (`404 target_not_found` otherwise). Inside one transaction the Node/MySQL Hub moves the source's `usage_events` rows wholesale, additively merges its `sessions` rows into the target's per (client, session) totals, and additively merges the target's period snapshots (today / month / allTime) and history document with the source's.

The source device keeps its identity and keeps recording normally. Its display snapshot is cleared and its ingest baseline is pinned to the pre-transfer cumulative counters with a `transferred` marker, so its next upload books only genuinely new usage — both in the event ledger and in the display aggregate. Repeated cumulative reports that contain no new usage change nothing.

Returns `400 same_device` when the source and target match. The transfer is the one operation where the ingest baseline intentionally diverges from the display snapshot; a regular ingest keeps them identical.

## `GET /api/usage/range`

Query a client/model token & cost aggregate for a custom calendar range. Desktop (hub mode) and Android both call this endpoint so custom-range totals stay aligned. This endpoint is implemented by the Docker Compose Node/MySQL Hub.

Legacy Instant bounds (still supported):

- `from` — inclusive lower bound (ISO-8601 timestamp)
- `to` — exclusive upper bound (ISO-8601 timestamp)

Preferred query parameters (local calendar days, same family as day/month tabs and tokscale `--since`/`--until`):

- `startDate` / `endDate` — inclusive `YYYY-MM-DD` bounds (aliases: `since` / `until`)
- `startHour` / `endHour` — optional `0–23` (defaults `0` / `23`). Hours are accepted for UI labels and future precision, but **totals are day-rounded**: the hub sums whole local days in `[startDate, endDate]`.

Callers should send **both** the day keys and the instants they name. The hub aggregates `history_daily` on the caller's `startDate`/`endDate` labels — which is what makes the window correct when the browser and the hub host sit in different timezones — and filters the `usage_events` ledger / head fill on the caller's absolute `from`/`to`. When only `from`/`to` are provided (legacy callers, e.g. a cached client bundle), the hub maps them to inclusive local calendar day keys on the hub host unless a valid IANA `tz` is supplied, in which case the keys are derived in that zone (`to` is exclusive, so the last included day is the calendar day of `to - 1ms`). An absent or invalid `tz` keeps the host-clock fallback, which is correct for same-zone callers.

Response:

```json
{
  "from": "2026-07-20T00:00:00.000Z",
  "to": "2026-07-21T00:00:00.000Z",
  "startDate": "2026-07-20",
  "endDate": "2026-07-20",
  "startHour": 0,
  "endHour": 23,
  "source": "history_daily",
  "totalTokens": 12345,
  "costUsd": 1.23,
  "clients": { "codex": 8000 },
  "clientCosts": { "codex": 0.8 },
  "models": { "gpt-5": 12345 },
  "modelCosts": { "gpt-5": 1.23 },
  "clientModels": { "codex": { "gpt-5": 8000 } },
  "clientModelCosts": { "codex": { "gpt-5": 0.8 } }
}
```

`source` preference:

1. **`history_daily`** (primary) — sum device `history.daily` rows whose `date` keys fall in the inclusive range. History dates are local `YYYY-MM-DD` keys from the tokscale graph (same scan family as trends / day-month rollups). Do **not** attribute custom-range totals from session timestamps.
2. **`usage_events`** (fallback only) — used when no overlapping history day exists for the window. The event ledger can mis-date first-ingest / counter-reset dumps via `lastUsedAt`, so it must not win over history.

`clientModels` / `clientModelCosts` are populated for the `usage_events` path; the `history_daily` path fills per-client and per-model maps from daily rollups when present, and may leave nested client→model maps empty.
