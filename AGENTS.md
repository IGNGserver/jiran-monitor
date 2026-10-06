> 设备级规范：`~/.qoder/coder-rules/global-rules.md`（本机所有 harness 已引入）。以下 6 行是模式判定，正文为仓库自有约定；冲突时安全条款以设备级为准。
Collaboration: solo
Baseline: main
Default branch: main
Release: tag + Actions（`.github/workflows/` 4 个，含各平台 dist 与 verify:deb）
Validation: 以 package.json 实际存在的脚本为准（`npm test`、`npm run test:mysql`、`npm run verify:deb` 等），不得臆造
Worktree: `~/项目/.wt/token记录系统/<slug>`

## 补充
- 本文件是架构与约定的权威文档：改动架构约定必须同步更新本文件。`CLAUDE.md` 已用 `@AGENTS.md` 引用本文件，不要再往它里面写内容。
- 历史里有 19 个外部作者邮箱，来自导入的上游历史，不代表有外部协作者：仍是 solo。
- 本机 8G 内存、仓库在 NAS 共享上：多 worktree 并行时依赖与产物走共享目录，不要各存一份。
- 文档面：README 只有 `README.md`（英文）与 `README.zh-CN.md`（简中）两份，逐工具一行的矩阵在
  `docs/supported-tools.md`，其余文档一律英文。界面语言（en/zh-CN/zh-TW/ja/ko）与文档语言是两件
  不同的事，不要为了"补齐语言"再把 ja/ko README 加回来。`tests/docs/*` 钉的是**产品事实**（矩阵
  行与顺序、README 计数与矩阵一致、必须存在的文档链接、已退役 surface 的禁用词），**不钉既有句子**——
  旧守卫把上游文案写成 5 个语言的正则，这是上游形状的报告反复回到 README 的直接原因，改写文案前
  先确认守卫是否又在钉措辞。

# AGENTS.md

The product is **计然 / Jiran** (renamed from Token Monitor in 2026-09; zh locales render 计然, en/ja/ko render Jiran — the user-visible name always comes from the `brand.name` i18n key, including native surfaces (menu bar, tray tooltip, About panel, window title), while `app.setName('Jiran')` stays the ASCII directory/install identity). The rename is a compatibility event, not a reset: `TOKEN_MONITOR_*` env names fold into `JIRAN_*` (legacy wins), `X-Token-Monitor-Secret` stays accepted beside `X-Jiran-Secret`, both userData and shared runtime state migrate from the legacy `Token Monitor` folder into `Jiran` (`src/electron/userDataMigration.js` + `src/shared/sharedDataMigration.js` — copy-forward, never overwriting the target, because a still-running pre-rename desktop/agent keeps writing the legacy folder, so `pidFileCandidates()` reads old and new `agent.pid`), apt publishes a `token-monitor` transitional stub beside the renamed `jiran` package, and releases dual-push both GHCR image names until the transition window closes. Identity surfaces deliberately did NOT move: `appId com.igng.tokenmonitor`, Android `applicationId com.igng.tokenmonitor.android`, the MySQL default database/user, SignPath `project-slug`, and GitHub Actions secret names.

This is the single source of project guidance, shared by every coding agent (Claude Code, Codex, Cursor, …). `CLAUDE.md` is a Claude Code compatibility shim that just imports this file — edit **this** file, not `CLAUDE.md`.

## Commands

```bash
npm start          # launch the desktop app (= npm run dev. The pre-rename `npm run widget` alias is gone; use either name)
npm run agent      # start the headless collector→hub agent
npm run agent:once # one-shot collect+post, then exit (useful for cron/launchd)
npm test           # run the node:test suite (node --test "tests/**/*.test.js")
npm run lint       # ESLint flat config (eslint.config.js)
npm run verify:product-scope # enforce the approved two-mode / Compose-only product boundary
npm run verify:android       # Android Fluent colour + component-boundary guards
npm run verify     # product-scope + shared-UI boundary + css-var + Android guards, lint, test
```

Automated verification is `npm run verify` (= `npm run verify:product-scope && npm run verify:shared-ui && npm run verify:css-vars && npm run verify:android-fluent-contrast && npm run verify:android-fluent-boundary && npm run lint && npm test`); CI (`.github/workflows/ci.yml`) runs lint + test on push/PR across Node 22 & 24, and a separate `android` job compiles the client and runs `:app:testDebugUnitTest` — the Android toolchain is not reachable from the Node matrix. The toolchain (ESLint 10 + the node:test glob) needs Node 22.13+, which is why `engines.node` is `>=22.13.0` (Node 18 & 20 are both EOL as of 2026-06).

```bash
cd android && ./gradlew :app:testDebugUnitTest   # Android JVM tests (Compose runtime is NOT loadable here)
cd android && ./gradlew :app:assembleDebug       # compile-only check
```

Android JVM tests cannot load `androidx.compose.*` runtime classes, so anything a JVM test must
reach stays free of Compose types and keeps its `CompositionLocal` in a separate file
(`DisplayFx.kt` is the precedent); behaviour that only exists inside a composable is asserted by
the Node guards or by hand instead.


### Version and release policy

- The root `VERSION` file is the shared version source. Build scripts, manifests, and verification tools inject it into generated artifacts. Project versions use standard SemVer `<major>.<minor>.<patch>` (e.g., `1.0.0`), with historical/transitional local revision `-rev.<positive integer>` supported for backward compatibility.
- Root `VERSION`, `package.json`, and lock metadata must stay strictly synchronized. `npm run verify:release-version` validates that `VERSION`, `package.json`, and `package-lock.json` are identical and strictly greater than the latest release tag.
- A normal request to “发布 release” means a GitHub prerelease. The release workflow defaults to `prerelease` for both pushed tags and manual dispatch. Only an explicit request to “发布正式版 release” may select the `release` workflow input. The Docker `latest` tag is updated only for a formal release; version-specific image tags are always published.
- Release tags are `v<project-version>`, and release jobs must check out and validate the exact tag. Android receives the same version through `-PtokenMonitorVersion` (falling back to reading `VERSION`).
- Release bodies are **Chinese-only**, and 本次更新 lives in **one file per version**: `.github/release-notes/<version>.md` (no `v` prefix) carries the hand-written block between the `app-update-notes:zh` markers, `.github/RELEASE_TEMPLATE.md` keeps only the `{{release_notes}}` placeholder, and `scripts/generate-release-notes.js` injects the file that matches the tag's version — plus the 快捷下载 list from its `RELEASE_ARTIFACTS` table and the Hub image section. One shared template block with every prep commit appending to it is how each release body accumulated the whole note history (and `latest*.yml` shipped it into the in-app updater); the renderer rejects markers in the template and fails when the version's file is missing, so cross-release accumulation is structurally impossible. `scripts/electron-builder.config.js` resolves `releaseInfo.releaseNotesFile` to the current version's file at build time — `package.json` has no `build.releaseInfo` anymore.
  A second language is how every release shipped the *previous* release in 繁體中文/한국어/日本語 (only `en`/`zh` markers were ever replaced), so the guards reject it now. A new artifact belongs in `RELEASE_ARTIFACTS` — that table is what puts it on the page; the Android APK was missing from downloads for exactly this reason.
- The desktop update channel follows the **installed** version, not a setting: a formal release (`1.2.3`) only ever considers non-prerelease publishes, while a `-rev.N` build follows the newest publish. `releaseMatchesInstalledChannel()` in `src/shared/appUpdater.js` is the single rule and gates both the GitHub release-list check and electron-updater's own feed. Note that electron-builder still writes one `latest*.yml` per platform that every publish overwrites, so "download the artifact that matches the channel" needs a per-channel metadata file in the release workflow before it can be relied on at install time.

To dry-run the agent without posting: `node src/agent/agent.js --once --dry-run`.

## Architecture

The desktop app, Docker Compose Hub, and headless agent share `src/shared/`, and the desktop app and the Hub dashboard additionally share `src/shared-ui/`:

- **`src/shared-ui/`** — the one UI both hosts render. Views, i18n, formatting, pure data transforms, client icons and styles live here. Every host-specific call goes through `src/shared-ui/transport/`: `httpTransport` for the Hub (fetch + SSE, same-origin) and `ipcTransport` for Electron (IPC to the main process, which owns the secret and the stream lifecycle). `scripts/verify-shared-ui-boundary.js` enforces that no view reaches for `fetch`, storage, `history`, dialogs or `window.tokenMonitor` directly — that is what keeps one implementation viable in both.
- **A data refresh must not interrupt the user.** A stats frame arrives every few seconds (SSE on the Hub, the collector tick on the desktop) and `render()` rebuilds `#content`; doing that unconditionally closes an open dropdown, snaps a half-typed value back, moves an expanded row and drops focus. Four rules keep it honest, asserted by `tests/shared-ui/refreshInterruption.test.js` rather than review: a data-driven `render({ quiet: true })` is *deferred* while a transient control is open (`hasOpenTransientInteraction` — a `fluent-listbox:popover-open`, an open management drawer, or a dirty scope the focused control belongs to) and replayed through the `pointerdown`/`focusout`/`keyup`/`toggle` listeners; a quiet render whose HTML is unchanged does not touch the DOM (`writeContentHtml`); `captureRenderState`/`restoreRenderState` restore open details by identity, open dropdowns, and nested scroll regions; and the chrome subtrees plus the entrance/chart animation are only rebuilt on a real change. **Call `render({ quiet: true })` from data paths (any promise settling, a stream/`settings:push` frame) and plain `render()` from user actions.**
- **Local usage adapters** — Proma, Claude Desktop, and Qoder Global/CN use the common descriptors in `src/shared/localUsageAdapters.js`; their file-format readers remain isolated. Periods expose the unified `clientMeasurements` provenance/native-meter map while `clientEstimated` and `clientCredits` remain compatibility aliases. The Qoder adapter is also used for matching Linux WSL homes, so Qoder markers are not sent to tokscale.
- **`src/electron/main.js`** — desktop process. Owns the BrowserWindow, app menu, IPC, and exactly two sync choices: *local* and *client*. It serves the shared UI's `/api/*` vocabulary from local data or a Hub proxy via `src/electron/desktopRequestRouter.js`. Native menu/tray labels come from `src/shared-ui/core/i18n.js`, which the main process `require()`s directly (Node's `require(esm)`, available in Electron's bundled Node) — there is deliberately no second catalog; `tests/electron/i18n.test.js` fails if a native string exists only in one of them.
- **Scope tabs are not all wire periods.** The *Day / Month / Total* tabs read `stats.periods`, which is the collector's fixed three-window scan. The *Yesterday* and *Week* tabs are calendar windows the UI computes in `src/shared-ui/core/dateRanges.js` and resolves through `/api/usage/range`, so they land in `state.customPeriod` exactly like a hand-picked range does and never widen the wire shape or the per-tick tokscale cost. Adding a preset there is a UI change; adding one to the wire is a collector + Hub + Android change. The range is fetched on selection and re-fetched only when its window stops matching (i.e. after midnight) — the match is *checked* on a snapshot frame, but a request goes out only when the window actually moved, because in local mode a range request runs tokscale. Two rules keep the surfaces honest, and both are asserted by tests rather than review: **the 本周 window is ISO Monday on every surface** (`SCOPE_WEEK_FIRST_DAY_INDEX`, `DateRanges.SCOPE_WEEK_FIRST_DAY_INDEX`) — locale-driven week starts belong to grids and heatmaps, never to a reported total; and **a range answer may only be consumed by the tab that asked for it** — `resolveScopePeriod()` in the shared UI and `ScopePeriod.resolve()` on Android are the only places a scope selection becomes a period, and each surface has exactly one copy. Anything that renders `customPeriod` / `customRangeResult` directly is a second measurement, and it is how one cached range used to print identical figures under 今日/昨日 and 本周/本月/全部.
- **`src/electron/renderer/`** — a shell (`index.html`, `desktop.css`) plus `boot.js`, which installs the IPC transport before importing the shared UI.
- **`src/hub/server.js`** — Node/MySQL HTTP Hub, used only by the root `docker-compose.yml`. It exposes `/api/ingest`, `/api/stats`, the staged reads `/api/stats/summary`, `/api/devices/:id` and `/api/sessions`, `/api/stats/stream` (SSE), and serves the same-port web dashboard / PWA from `src/hub/web/` via `src/hub/static.js`; the shared UI is served under `/ui/`. The Hub source is intentionally excluded from Electron packages.
- **Reads are staged and compressed, because the mobile client is on a phone.** A fleet snapshot carries every device's session archive and client×model grain; at the ~1 MiB per-device ingest cap that is megabytes of JSON even for a handful of machines, and the same document used to be sent twice (REST + the SSE first frame) on every refresh. Three rules, all asserted by tests: every JSON response is compact and compressed per `Accept-Encoding` (`sendBuffer` in `src/shared/http.js` — a multi-megabyte fleet must not be pretty-printed, and compression must not run on the event loop, so it uses the async zlib API); `/api/stats` stays the full shape for the desktop and web hosts while `/api/stats/summary` is the *first-paint projection* of the same aggregate (device periods reduce to totals, the session/project maps drop) and `/api/stats/stream?detail=slim` sends that projection as the frame, with `historyRevision`/`deviceHistoryRevision` as the tokens that tell a client the omitted documents moved — the stream's default stays full because the shared renderer reads detail straight off it and has no re-fetch path; and `/api/stats`, `/api/history` and `/api/devices/:id` share one `getFleetRecords()` read per mutation generation so a second endpoint never re-queries the fleet or re-normalizes it. `summarizeStats` is a projection, never a second measurement — the headline numbers must stay identical to `/api/stats` or the two surfaces disagree.
- **`src/agent/agent.js`** — headless collector for machines without the desktop app. It is a sync client and posts to the Docker Compose Hub.
- **`android/`** — a native Kotlin/Compose read client for the Docker Compose Hub (`/api/*` + SSE, no collector, no `POST /api/ingest`). It shares Fluent 2 tokens and semantics with the shared renderer but is a separate UI: its component contract is `docs/design/android-fluent2-contract.md`, and it enforces that contract with ratchet guards rather than review, because it is the one surface with no shared code to keep it honest. It consumes the same `clientStatus` / `wslStatus` / `limits` / accounts records the Hub serves, and it renders the *same* provenance rules (`clientEstimated` → `~`, `clientCredits` as a separate unit) — a client that drops provenance is reporting an estimate as a measurement.

The product boundary is recorded in `product-scope.json`: no embedded widget Hub, no standalone `npm run hub` entry point, and no secondary Worker deployment. Run `npm run verify:product-scope` before changing any deployment or sync code.

### Collector pipeline (shared by the desktop app and the agent)

`src/shared/collector.js` is the only place that invokes `tokscale`. It:
1. resolves the platform binary from `@tokscale/cli-<platform>-<arch>` and falls back to the JS shim under Electron via `ELECTRON_RUN_AS_NODE=1`;
2. runs three `tokscale --json --client <csv> --group-by client,model` calls (today / month / since `allTimeSince`) on full ticks (startup / interval / manual) — serially on purpose: concurrent scans triple peak CPU/IO. Watch-triggered ticks instead scan only `--today` and derive month/allTime **exactly** via `applyPeriodDelta()` anchored to the last full scan (every tokscale period scan costs the same full-load+filter, so the win is 3 spawns→1; the delta is an identity for append-only logs, NOT an estimate; stale-date anchors force a full scan);
3. funnels output through `extractUsageFromTokscale()` in `src/shared/usage.js`, which is a defensive deep-walker over tokscale's JSON shape (it never assumes a fixed layout — that's why `tokenValue`/`detectClient` accept many key spellings);
4. watches the per-client data directories from `watchPathsForClients()` with chokidar (`usePolling: true, interval: 2000`) and debounces refreshes by `watchDebounceMs` (no cooldown — the product promises 3–5 s updates; mid-tick watch events re-arm the debounce timer instead of coalescing). The cursor/antigravity tokscale cache dirs are deliberately *not* watched — only our own `maybeSync*` calls write them, so watching them re-triggers forever — and those syncs are gated + throttled (`SYNC_MIN_INTERVAL_MS`).
5. on Windows, also scans usage from **running** WSL distros (`src/shared/wslUsage.js`). It registry-gates on `HKCU\…\Lxss` (so `wsl.exe` is never spawned without WSL — the inbox stub otherwise shows an interactive install prompt), lists running distros via `wsl.exe --list --running` (never auto-starts a stopped one), keeps homes containing tracked-client data, and runs `tokscale --home \\wsl$\<distro>\home\<user>` per home (serial, same CPU/IO reason as above). `--home` disables tokscale's env roots upstream, so a WSL scan cannot read the Windows home by mistake. The bundle is merged into the Windows periods in `collectUsageOnce` **before** `deriveClientStatus` (so a WSL-only client still shows active); `mergePeriods`/`addPeriodInto` (in `usage.js`) do the additive sum. WSL is **not** file-watched (a 9P watch is unreliable and heavy), so it is rescanned on every interval tick and, at most once per `wslRefreshIntervalMs` (default 60 s), on an anchored watch tick — bounded staleness instead of the host's seconds-level refresh. On history ticks the same per-home `tokscale graph --home` is merged into `history` too, so WSL past days are re-derivable rather than surviving only in the local daily-history archive's `liveDays` overlay. The Windows-only delta anchor stays exact because WSL is merged after the delta is computed. Days are bucketed in the **Windows host** timezone (tokscale runs as a Windows process), not the distro's — or in the Hub's fleet calendar when one is configured, since the same `scanner.bucketTimezone` pin governs WSL scans. Non-`win32` is a no-op. Default on, no setting.

### AI Tool Limits collector

Quota probing is Hub-owned: the desktop app and the headless agent never probe provider accounts or upload credentials. `src/shared/deviceRuntime.js` runs only the `UsageRuntime` (the tokscale collector); its `clearLimits`/`refreshLimits`/`reconfigureLimits` are inert no-ops kept for call-shape compatibility, and device wire records carry no `limits`. `src/hub/accountService.js` owns the account store (encrypted credentials via `accountCrypto`), the refresh timer, retry/backoff and `lastGood` retention, and dispatches probes through `probeLimitProvider()` in `src/shared/limitCollector.js` — provider implementations are split between that file and `src/shared/*Limits.js`, with shared normalization in `src/shared/limits.js`. The Hub publishes the sanitized snapshot as the top-level `limits` of `/api/stats` and the SSE stream (device-level `limits` are stripped on read); the desktop's limits page has no other source, so local mode renders it empty by design.

Because the Hub answer is the only limits authority, every desktop client-mode display path funnels Hub stats through `composeLocalSyncStats()` (`src/electron/syncDisplayStats.js`), which must pass the Hub's top-level `limits` through untouched — re-aggregating limits from device records (the retired device-probe contract) silently blanks every limits card, and the Hub always sends `staleAfterMs`, so the retired preference fired on every frame. `tests/electron/syncDisplayStats.test.js` pins the pass-through and the legacy-snapshot fallback.

### Local / client mode switching

`main.js` chooses between `local` and `client` from `settings.hubMode`, set in the settings view's Hub connection group. In `client` mode (a `hubUrl` is set) it stops the local-only collector, opens an SSE stream to `/api/stats/stream`, and also runs a sync collector to post this device's own usage. In `local` mode it runs only the local collector and emits stats over IPC, which the shared UI reads through its transport. A legacy `host` value is migrated to `local` and its embedded-Hub settings are discarded; it is not a supported runtime mode.

The only supported Hub deployment is the root Docker Compose stack. `src/hub/` remains part of the Docker image and release Compose archive, but never part of the Electron package. When both the desktop app and the headless agent run on the same machine, the app's sync collector backs off — it checks `agent.pid` in the shared data dir via `pidFileCandidates()` (the new `Jiran` directory first, the legacy `Token Monitor` one as fallback while a pre-rename agent is still alive) and skips posting if any of those PIDs is alive.

### Settings and credentials: env first, GUI overrides for the desktop app

Configuration has two sources, and the desktop app splits its persisted GUI state by sensitivity. What the app *collects* is not configuration at all: `src/shared/collectorConfig.js` fixes the tracked set, the cadence, history, the session archive, Projects and the WSL scan, and `main.js` keeps one `RETIRED_SETTING_KEYS` list that strips every key whose surface is gone on both the read and the write path — a retired key must not come back through the path that did not retire it:

1. **`.env` at project root** — read by `loadDotEnv()` in `src/shared/config.js` at the top of every entry file. Only assigns keys that aren't already in `process.env`, so real env vars (systemd / launchd / Docker) still win. `.env.example` documents the operator-facing settings intended for direct configuration, including connection/device settings, feature toggles, and provider credentials. Lower-level runtime knobs may still be accepted without being listed there; treat additions or removals from the documented env surface as compatibility changes and keep `.env.example` aligned with the code.
2. **Desktop GUI** — Electron `userData/settings.json` stores preferences and account metadata; plaintext `userData/credentials.json` stores GUI-managed raw credentials with restrictive filesystem permissions (POSIX `0600`; Windows relies on the containing `userData` ACL). `readSettings()` merges both over `defaultSettings()` (which is seeded from env). The snapshot sent to the renderer omits every raw credential **and** the main process's own runtime state (`INTERNAL_ONLY_SETTING_KEYS`: `windowBounds`, `lastViewState`, `lastPostedDeviceId`, `appUpdate`), and `settings:update` refuses those same keys plus every `RETIRED_SETTING_KEYS` name in both directions, so a renderer write cannot clobber them or revive a retired behaviour; the desktop settings surface, the retained-key set, and "no settings key survives without a writer" are asserted by `tests/electron/settingsMigration.test.js`. The single Hub secret is the only raw credential exposed to the renderer, and `ipcTransport` never forwards its value — the UI only learns whether a Hub is configured. The headless agent and Docker Compose Hub never read `credentials.json`; their credential flow remains CLI/env-based.

`CREDENTIAL_SETTING_PATHS` in `src/shared/credentialStore.js` maps fixed GUI credential settings. Add new fixed credentials there instead of creating provider-specific stores; dynamic account credentials such as MiMo cookies belong under a dedicated nested path in the same unified store and must remain metadata-only in the renderer. The single Hub secret is the only raw credential exposed by the sync UI. Expose any other raw credential to the renderer only through an explicit allowlist. Legacy migration must write and verify the new store before stripping/deleting the old source; corrupt, unknown-version, or symlinked stores must never be replaced with an empty document. This store is deliberately local plaintext protected by filesystem permissions, not OS-backed encryption: it avoids Keychain/credential-manager prompts but does not protect against processes already running as the same OS user.

Per-setting precedence for the agent and hub: `CLI flag → env var (real or .env) → built-in default`. There is no JSON config file anymore — `config.local.json` was removed.

### Adding a tracked client

The tracked client list lives in **one** place: `TRACKED_CLIENTS` in `src/shared/clientTracking.js`. It is the complete wired set, not a default: every runtime always collects it (there is no client-selection setting, and the old `TOKEN_MONITOR_CLIENTS` / `--clients` surface was removed), so adding a client also enrolls it everywhere on upgrade. `tests/shared/clientPartitionInvariants.test.js` asserts the *reverse* coverage too — every tracked id must have a watch root (or be a self-synced allowlist id), a WSL marker (or a written reason it cannot have one), and a reachable scan path, because with no selection surface an unreachable client is silent under-counting rather than a visible "not tracked" state. Adding a *new* client means touching several spots that must all agree on the id:

| Touch point | Where |
|---|---|
| Tracked client list | `TRACKED_CLIENTS` in `src/shared/clientTracking.js` |
| Watch paths | the `add(...)` call in `clientWatchCandidates()` (`src/shared/collector.js`) |
| Name normalization | the `normalizeClientName()` branch in `src/shared/usage.js` |
| UI labels / colours | `CLIENT_LABELS` / `CLIENT_COLORS` in `src/shared-ui/core/data.js`, plus the `ICON_ALIASES` entry if the file name differs from the id |
| Icon assets | `src/shared-ui/icons/clients/<id>.svg` (the one tree both hosts serve) + `.github/assets/tools-icon/<id>.png` |
| WSL discovery | marker(s) in `WSL_DATA_MARKERS` **and** the marker→id mapping in `MARKER_CLIENTS` (`src/shared/wslUsage.js`) — use the exact roots tokscale reads, including alternate roots. A marker without a `MARKER_CLIENTS` entry attributes to nothing, so a WSL home holding only that client's data would be skipped |
| Docs | the supported-tools matrix in `docs/supported-tools.md` — the READMEs publish only its counts — plus the Qoder/MiMo prose where a client's provenance is explained. `tests/docs/supportedToolsTable.test.js` pins the matrix rows, order and icon ids; `tests/docs/readmeConsistency.test.js` fails when a README's counts stop matching the matrix |
| Guard tests | the expected-client lists in `tests/shared/clientTracking.test.js` and the matrix icon mapping in `tests/docs/supportedToolsTable.test.js` |
| Android client | `CLIENT_LABELS` / `CLIENT_COLORS` in `ClientBranding.kt` (same strings/hex as the shared UI — `tests/shared/clientTracking.test.js` fails otherwise), plus the mark: vendor `res/drawable/client_<id>.xml` and add the key in `ClientIcons.kt`, or add an `aliases` entry when the id shares another id's logo. `npm run update:fluent-assets` regenerates the **Fluent colour tokens only** — it does not convert SVGs. An SVG that needs filters, gradients or transforms is skipped *by design* and falls back to the letter monogram; nothing breaks, the mark just does not appear |

Two caveats on top of the table:

- Self-synced clients (cursor/antigravity) additionally go in `SELF_SYNCED_CLIENTS`; parse-local clients must NOT.
- A tracked id is not necessarily the id tokscale spells. `tokscale --client` is a clap value-enum: an id outside it is a hard usage error (exit 2, empty stdout), so one unknown id fails the whole scan — every other client in the same call included. `TOKSCALE_CLIENT_RENAMES` / `TOKSCALE_CLIENT_ALIASES` in `collector.js` are therefore load-bearing: rename an id tokscale rejects (`deepseek-harness` → `dsh`), and alias an id whose usage tokscale splits across two (`pi` → `pi,omp`, since 4.14 moved Oh My Pi's `~/.omp` root to its own `omp` client). Every downstream consumer must fold those upstream ids back — `normalizeClientName` for usage rows, and `normalizeGraphClientIds` for the history graph, which tokscale keys by its own ids. `tests/shared/clientTracking.test.js` asserts every tracked client maps to an id the bundled tokscale actually accepts.

### Data flow contract

The Docker Compose Hub stores normalized device records (`normalizeDeviceRecord` in `usage.js`) and aggregates on read (`aggregateDevices`). The wire shape between device and Hub is whatever `collectUsageOnce()` returns — that function is the source of truth, and `docs/API.md` documents the full contract. The core is `{deviceId, hostname, platform, updatedAt, agentVersion, today, month, allTime}` (each period has `{totalTokens, costUsd, clients, clientCosts, models, modelCosts}`), plus attribution fields (`trackedClients`, `clientStatus`, `wslStatus`, `periodWindows`, `projectsEnabled`) and optional `osName` / `osVersion` / `agentRuntime` / `history` / `limits`.

### The fleet calendar

Every `today`/`month` is a wall-clock window in some zone, and the Hub sums devices' windows directly. With each device on its own OS zone those windows do not align: a UTC-8 device's local midnight lands at 16:00 in a UTC+8 fleet, so its whole day leaves the aggregate at that instant while the fleet's day is still open (and before it, its previous day over-counted). `TOKEN_MONITOR_FLEET_TIMEZONE` / `JIRAN_FLEET_TIMEZONE` (IANA name, Hub-side) makes every syncing device bucket `periodWindows`, history day keys and every local-parser window (Proma, Claude Desktop, both Qoder sites, the Reasonix native view) into one calendar. The Hub advertises it on `/api/health`, `/api/stats` and both ingest response shapes; a device remembers it in `fleet-time-zone.json` under the shared data dir (`src/shared/fleetTimeZone.js`), with the env var as the operator override and pre-seed.

`src/shared/tokscaleSettings.js` is the load-bearing half: tokscale 4.17+ pins `scanner.bucketTimezone` on first run and refuses to change a valid pin, so Jiran maintains the value in the settings file it already mirrors. `--today`, `--month` and `graph` then bucket in the fleet zone, which is what makes the device's tokscale periods agree with its own `periodWindows`. A zone change is a one-time re-key: the collector clears `daily-history-archive.json`, `session-usage-archive.json` and `collector-anchor.json` and takes a full scan, and the Hub replaces the device's stored history wholesale on the next sync. Unset is inert — every existing fleet keeps per-device calendars until the operator opts in, and the Hub-side fallbacks (`liveUsageRangeFromDevices`, `aggregateHistory`'s clock fallback, legacy `from`/`to` label derivation) use the fleet zone only when configured.

### Product boundary and architecture governance

`product-scope.json` records the approved architectural boundary for this project: Electron exposes only `local` and `client`, and Hub deployment uses only the root Docker Compose stack. An embedded Hub, a standalone Hub command, and a secondary Worker deployment tree are strictly prohibited. Keep the scope guard in CI, release verification, and `npm run verify`. If future features adjust settings, renderer, build, or deployment files, update the implementation and its guard together.

Device data transfer (`POST /api/devices/:id/transfer`) is a Hub-web owner-only capability and the deliberate exception to "one UI, two hosts": it renders only in the web Management page's Advanced section for the authenticated owner (`!desktopHost && owner` in `src/shared-ui/views/settings.js`), and the desktop client has no code path to it — no navigation destination, no render case, and `desktopRequestRouter.js` does not proxy the route. The `verify:product-scope` guard asserts all three.

The Administration navigation group has one destination: the view whose id is `settings`, labelled 管理. On the **Hub web host** it consolidates three surfaces that used to be separate views — provider accounts, the subscriptions/pricing ledger (消费), and the browser preferences — as sections of one page, with the left-hand settings rail switching between them. `accounts` and `management` are no longer views: a persisted view, bookmark or old URL for either redirects to `settings` with the matching section (`VIEW_REDIRECTS` / `VIEW_SECTION_REDIRECTS` in `src/shared-ui/app.js`). The view id `settings` stays because it is the persisted-route and native-menu compatibility surface — only the label changed. The **desktop host renders none of those sections**: credentials and the shared ledger live on the Hub, so 账号 / 消费 / 偏好 are Hub-web-only and the desktop page is the three device groups from `views/settingsDesktop.js` (显示 / 行为 / 中枢连接). `views/settings.js` owns the per-host section list (`managementSections()` / `canRenderManagementSection()` / `normalizeManagementSection()`) and it is the only copy: the router normalizes against it, the 额度 card's 账号 jump asks it, and `bootstrapAuthorized()` skips the accounts/subscriptions/pricing prefetch on desktop, because a section that is hidden but still fetched shows up as a Hub round trip (and a 401 auth prompt) on a machine that never renders it. 显示 carries the appearance keys the Hub keeps in 偏好 (language, theme, currency) — they are `settings.json` keys this machine's window, locale and cost formatters read, so removing the section must not remove their only writer. The desktop has no prefs store of its own: the preload bridges PREFS_KEYS onto `settings.json`, so a settings write must land back in `state.prefs` (`adoptDesktopPrefs()` in `app.js`) or the theme, locale and currency keep rendering pre-change values until restart.

### Stale devices

A device is "stale" if `Date.now() - receivedAt > staleAfterMs` (default 10 min). Stale devices still appear in `/api/stats` with `stale: true`, and the renderer greys them out — this is intentional, not a bug.

## Conventions

- **Consider best practices first.** When picking an approach — library vs hand-roll, pattern vs custom, framework default vs override — start by checking the ecosystem convention, not by optimizing for "fewer deps" or "less code". If a hand-rolled solution is genuinely better, argue that *after* weighing the convention.
- **This project has external users.** Settings keys, env vars, CLI flags, hub endpoints, and the wire shape (`docs/API.md`) are compatibility surfaces — treat changes to them as breaking and think about migration. Internal code can still be refactored and renamed freely.
- **Don't add dependencies or new tooling without discussing it first** (in the issue or PR description).
- **Keep this file lean and current.** Document non-obvious constraints and gotchas, not descriptions the code already makes obvious. Avoid hardcoded counts and exhaustive lists (prefer a command like `ls src/shared/` over a hand-maintained one); verify claims against the code before writing them; delete anything that has gone stale — an outdated note is worse than none.

### Commit messages

Format: `<type>(<scope>): <subject>` — conventional-commit types (`feat` / `fix` / `refactor` / `docs` / `chore` / `perf` / `test` / …), with a scope when the change targets a clear subsystem (`fix(hermes):`, `fix(collector):`, `feat(limits):`); leave it off for cross-cutting or general changes. Aim for a subject ≤ ~72 chars that describes the actual change. Add a **body** only when the diff doesn't make the *why* obvious — rationale, rejected alternatives, behaviour-preserving notes, linked issues; trivial changes stay single-line. Write body paragraphs as continuous lines, not hard-wrapped.

**Do:**

```
fix(dashboard): balance stat card widths
feat(wsl): scan usage from running WSL distros
docs(i18n): add Japanese README
```

**Don't** — vague subjects, or internal review/agent jargon (`P0`/`P1`, "review findings", "hardening pass"):

```
fix: address P0 review findings   ❌
fix: hardening pass round 2       ❌
fix: various improvements         ❌
```

Never add an AI `Co-Authored-By` trailer. **Do** keep the genuine human `Co-authored-by:` trailer on a multi-author squash (e.g. a maintainer follow-up on a contributor PR) and keep the `(#NN)` PR-number suffix GitHub appends to squash subjects.

### Pull requests

- PR titles follow the commit-message convention above — they become the squash-merge subject.
- In the description: summarize the behaviour change, note the commands you ran (`npm run verify` at minimum), attach screenshots/GIFs for UI changes, and link the related issue.

### Authoring GitHub content via `gh`

Write PR/issue bodies and comments to a file and pass it, rather than inline heredocs: `gh issue comment --body-file <path>`, `gh api -X PATCH … -F body=@<path>`. Inline `--body "$(cat <<EOF … EOF)"` mangles backtick escaping and renders as a literal `` \` `` in GitHub markdown. Same spirit for prose: write paragraphs as continuous lines and let GitHub wrap them — don't hard-wrap at 80 columns.
