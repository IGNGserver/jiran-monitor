# Supported tools

Every AI coding tool and provider that 计然 / Jiran reads, and what it reads from each one.
This matrix is the authoritative list — the [README](../README.md) only summarises it, and
`tests/docs/supportedToolsTable.test.js` fails when a client wired into
`TRACKED_CLIENTS` has no row here.

Three capabilities are tracked separately, so a tool can support any subset of them:

| Column | What a ✅ means |
|---|---|
| **Token Usage** | Tokens and cost come from the tool's own local records (transcripts, session DBs, or a tokscale cache). Nothing is inferred from another tool. |
| **AI Tool Limits** | Plan quota windows — session / weekly / billing / credits — are probed for that provider by the Hub, from the account configured there, and the normalized result is published to every connected device. Device-side probing is not a quota source. |
| **Session Details** | Individual sessions can be opened to see tokens per prompt. Always read on demand from the local machine, never uploaded. |

**Reading the numbers honestly.** Where a tool does not persist real token counts, the
total is estimated from the stored text and is rendered with a leading `~` in every surface;
credits a provider bills in are a separate unit, never folded into a token total. A tool
that is present but idle shows as an inactive client rather than as zero usage.

The matrix — 59 rows, in the order the UI lists them:


| Logo | Tool | Data path | Token Usage | AI Tool Limits | Session Details |
|:---:|------|-----------|:---:|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`, `~/.claude/transcripts/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/claude-desktop.png" width="28" alt="Claude Desktop" /> | Claude Desktop | `<platform-app-data>/Claude/` and `Claude-3p/` (Local Agent / Cowork transcripts) | ✅ | — | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/` (`sessions/`, `archived_sessions/`) | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/` (`opencode*.db`, `storage/message/`) | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes Agent" /> | Hermes Agent | `~/.hermes/state.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor | `~/.config/tokscale/cursor-cache/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/antigravity.png" width="28" alt="Antigravity" /> | Antigravity | `~/.gemini/` (`antigravity/`, `antigravity/conversations/`, `antigravity-ide/`, `antigravity-backup/`, `antigravity-cli/conversations/`) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/cline.png" width="28" alt="Cline" /> | Cline | VS Code globalStorage tasks (`.../saoudrizwan.claude-dev/tasks/`), `~/.cline/data/sessions/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kimi.png" width="28" alt="Kimi" /> | Kimi CLI / Kimi Code | `~/.kimi/sessions/`, `~/.kimi-code/sessions/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/qwen.png" width="28" alt="Qwen" /> | Qwen CLI | `~/.qwen/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/xai.png" width="28" alt="Grok Build" /> | Grok Build | `~/.grok/` (`sessions/`, `logs/unified.jsonl`) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/copilot.png" width="28" alt="GitHub Copilot" /> | GitHub Copilot | VS Code `workspaceStorage/*/chatSessions/`, `~/.copilot/` (`otel/`, `data.db`) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/pi.png" width="28" alt="Pi" /> | Pi / Oh My Pi | `~/.pi/agent/sessions/`, `~/.omp/agent/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/zed.png" width="28" alt="Zed" /> | Zed | `~/.local/share/zed/threads/threads.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kilocode.png" width="28" alt="Kilo Code" /> | Kilo Code | VS Code globalStorage tasks (`.../kilocode.kilo-code/tasks/`) — Linux & remote/WSL only | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/commandcode.png" width="28" alt="Command Code" /> | Command Code | `~/.commandcode/projects/**/*.jsonl` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/mimo-code.png" width="28" alt="MiMo Code" /> | MiMo Code | `~/.local/share/mimocode/mimocode.db` (imports Claude Code sessions; tokscale does not dedup them, so Claude totals can be inflated) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/zcode.png" width="28" alt="ZCode" /> | ZCode / GLM | `~/.zcode/` (`projects/`, `cli/db/db.sqlite`) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kiro.png" width="28" alt="Kiro" /> | Kiro | `~/.kiro/sessions/cli/`, Kiro IDE globalStorage & `kiro-cli` DB | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/codebuddy.png" width="28" alt="CodeBuddy" /> | CodeBuddy | `~/.codebuddy/projects/` + IDE / VS Code extension logs | ✅ | — | — |
| <img src=".github/assets/tools-icon/workbuddy.png" width="28" alt="WorkBuddy" /> | WorkBuddy | `~/.workbuddy/projects/`, `~/.workbuddy/workbuddy.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/proma.png" width="28" alt="Proma" /> | Proma | `~/.proma/agent-sessions/*.jsonl` | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek-harness.svg" width="28" alt="DeepSeek Harness" /> | DeepSeek Harness | `$DSH_HOME/sessions/` (default `~/.dsh/sessions/`; `session.jsonl[.zstd]` and versioned `session.v<N>.jsonl[.zstd]`) | ✅ | — | — |
| <img src=".github/assets/tools-icon/qoder.png" width="28" alt="Qoder" /> | Qoder / Qoder CN | Local adapter per edition: `~/.qoder/projects/` and `~/.qoder-cn/projects/` transcripts, plus `<platform-app-data>/Qoder/` & `QoderCN/SharedClientCache/cache/db/local.db` and `com.qoder.app.stable/` & `com.qodercn.app.stable/main.sqlite` when present; Qoder dashboard cookie (big-model credits via Qoder usage API) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/reasonix.png" width="28" alt="Reasonix" /> | Reasonix | `~/.reasonix/` (`stats/`, `sessions/`, `projects/*/sessions/`) | ✅ | — | ✅ |
| <img src=".github/assets/tools-icon/gemini.png" width="28" alt="Gemini CLI" /> | Gemini CLI | `~/.gemini/tmp/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/roocode.png" width="28" alt="Roo Code" /> | Roo Code | VS Code globalStorage tasks (`.../rooveterinaryinc.roo-cline/tasks/`) | ✅ | — | — |
| <img src=".github/assets/tools-icon/amp.png" width="28" alt="Amp" /> | Amp | `~/.local/share/amp/threads/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/droid.png" width="28" alt="Droid" /> | Droid | `~/.factory/sessions/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/mux.png" width="28" alt="Mux" /> | Mux | `~/.mux/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kilo.png" width="28" alt="Kilo CLI" /> | Kilo CLI | `~/.local/share/kilo/kilo.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/crush.png" width="28" alt="Crush" /> | Crush | `~/.local/share/crush/projects.json` | ✅ | — | — |
| <img src=".github/assets/tools-icon/goose.png" width="28" alt="Goose" /> | Goose | `~/.local/share/goose/sessions/sessions.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/codebuff.png" width="28" alt="Codebuff / Freebuff" /> | Codebuff / Freebuff | `~/.config/manicode/projects/` (`chats/*/chat-messages.json`) | ✅ | — | — |
| <img src=".github/assets/tools-icon/trae.png" width="28" alt="Trae" /> | Trae | `~/.config/tokscale/trae-cache/` (after `tokscale trae sync`) | ✅ | — | — |
| <img src=".github/assets/tools-icon/warp.png" width="28" alt="Warp / Oz" /> | Warp / Oz | `~/.config/tokscale/warp-cache/` (after `tokscale warp sync`) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/gjc.png" width="28" alt="Gajae-Code" /> | Gajae-Code | `~/.gjc/agent/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/jcode.png" width="28" alt="Jcode" /> | Jcode | `~/.jcode/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/junie.png" width="28" alt="Junie" /> | Junie | `~/.junie/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/opencodereview.png" width="28" alt="OpenCodeReview" /> | OpenCodeReview | `~/.opencodereview/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/devin.png" width="28" alt="Devin CLI / Devin Desktop" /> | Devin CLI / Devin Desktop | `~/.local/share/devin/cli/sessions.db`; `~/Library/Application Support/Devin/User/acp-events/` (macOS) | ✅ | — | — |
| <img src=".github/assets/tools-icon/senpi.png" width="28" alt="Senpi" /> | Senpi | `~/.senpi/agent/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/augment.png" width="28" alt="Augment Code" /> | Augment Code | `~/.augment/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kimchi.png" width="28" alt="Kimchi" /> | Kimchi | `~/.config/kimchi/harness/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/prime-agent.png" width="28" alt="Prime Agent" /> | Prime Agent | `~/.prime/agent/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cherrystudio.png" width="28" alt="Cherry Studio" /> | Cherry Studio | `~/.config/CherryStudio/.claude/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/mcode.png" width="28" alt="MiniMax Code" /> | MiniMax Code | `~/.config/tokscale/headless/mcode/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/fx.png" width="28" alt="Fx" /> | Fx | `~/.fx/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/lmstudio.png" width="28" alt="LM Studio" /> | LM Studio | `~/.lmstudio/server-logs/` (final response usage only; local inference is $0) | ✅ | — | — |
| <img src=".github/assets/tools-icon/unsloth.png" width="28" alt="Unsloth" /> | Unsloth | `~/.unsloth/studio/studio.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/hindsight.png" width="28" alt="Hindsight" /> | Hindsight | `~/.hindsight/usage/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek.png" width="28" alt="DeepSeek" /> | DeepSeek | DeepSeek API key (balance via DeepSeek API) | — | ✅ | — |
| <img src=".github/assets/tools-icon/openrouter.png" width="28" alt="OpenRouter" /> | OpenRouter | OpenRouter API key (usage/key limit; balance when credits access is authorized, documented for Management keys) | — | ✅ | — |
| <img src=".github/assets/tools-icon/minimax.png" width="28" alt="Minimax" /> | Minimax | Minimax API key (Token Plan quota via Minimax API) | — | ✅ | — |
| <img src=".github/assets/tools-icon/volcengine.png" width="28" alt="Volcengine" /> | Volcengine | Ark API key or Volcengine AK/SK (Ark Coding Plan quota via Volcengine API) | — | ✅ | — |
| <img src=".github/assets/tools-icon/ollama.png" width="28" alt="Ollama" /> | Ollama | Ollama Cloud cookie (session/weekly usage via ollama.com/settings) | — | ✅ | — |
| <img src=".github/assets/tools-icon/newapi.png" width="28" alt="Third-party APIs" /> | Third-party APIs | New API-compatible account preset (including compatible One API forks), New API API-key preset, and a declarative Custom balance endpoint | — | ✅ | — |
| <img src=".github/assets/tools-icon/sakana.png" width="28" alt="Sakana (Fugu)" /> | Sakana (Fugu) | Sakana billing console session cookie | — | ✅ | — |

<details>
<summary><strong>Notes, Custom balance endpoints, and data paths overridden by environment variables</strong></summary>

<br>

- Paths above are the defaults. Jiran follows the same environment overrides Tokscale does — `$XDG_DATA_HOME` for the `~/.local/share/` roots, and per-tool variables such as `$CODEX_HOME`, `$GROK_HOME`, `$HERMES_HOME`, `$KIMI_CODE_HOME`, `$REASONIX_STATE_HOME`, `$REASONIX_HOME` and the `$CLINE_*` family.

- Command Code v3 transcripts persist per-request `usage` (input / output / cache-read / cache-write tokens, plus the provider-reported `costUsd`), so those sessions are exact rather than estimated. Only legacy transcripts written before the `usage` block existed fall back to a text-based estimate, and their model attribution may reflect the currently configured model rather than the model historically used for each request.

- Custom maps numeric JSON fields from one GET balance endpoint; OpenAI or Anthropic compatibility alone is not enough.

#### Qoder / Qoder CN (local adapter)

Qoder token usage is read from the app's own local files, not an API. The international and China editions are tracked as two separate clients — `qoder` and `qodercn` — because they keep separate profiles, and both are always tracked (there is no per-tool opt-in). Three sources per edition are probed and whichever exist contribute:

- **Transcript tree — the primary source in current builds.** `~/.qoder/projects/**/*.jsonl` (international) or `~/.qoder-cn/projects/**/*.jsonl` (CN), one JSON line per request. It is watched for live updates and needs nothing but the filesystem. Point `JIRAN_QODER_TRANSCRIPTS_DIR` / `JIRAN_QODER_CN_TRANSCRIPTS_DIR` at a different root, or set Qoder CN's own `QODERCN_CONFIG_DIR` when the whole profile is relocated.
- **Desktop message store.** `com.qoder.app.stable/main.sqlite` (international) or `com.qodercn.app.stable/main.sqlite` (CN) under the platform application-support directory; override with `JIRAN_QODER_MAIN_DB_PATH` / `JIRAN_QODER_CN_MAIN_DB_PATH`. Qoder CN 0.1.x used the international spelling, so both candidates are tried for the CN site.
- **Legacy cache database.** `<platform-app-data>/Qoder/SharedClientCache/cache/db/local.db` (international) or the same path under `QoderCN/` (CN) — macOS `~/Library/Application Support/`, Windows `%APPDATA%\`, Linux `~/.config/`; override with `JIRAN_QODER_DB_PATH` / `JIRAN_QODER_CN_DB_PATH`.

`com.qoder.app.stable` is claimed by both editions, so a site reads it only when that site's own footprint (app-support or profile directory) is also present: an international-only machine is never billed to `qodercn`, and a CN 0.1.x-only machine is never billed to `qoder`. Which sources actually exist varies by edition and install — on the Linux machine this was verified against (2026-09-26, Qoder CN 0.4.2) the CN site had transcripts and `com.qodercn.app.stable/main.sqlite` but no legacy cache database, while the international CLI-only install had transcripts alone.

Rows from every present source are merged additively and de-duplicated by request identity. Where a transcript row cannot be proven distinct from a database row, the database row wins — two sources that overlap must not double-count.

This is an advanced local integration. Either SQLite source needs a `sqlite3` CLI on PATH or a Node runtime with unflagged `node:sqlite` (Node ≥ 23.4; the Electron app may need the CLI); the transcript tree needs neither. Read failures are logged, and an existing complete snapshot is retained instead of being replaced with zero usage. Main-database and transcript rows use a blended estimate of CJK characters / 1.5 and other characters / 4; a request's input is the conversation appended **since the previous request** and its output is that request's stored content, so each message of a session is counted once rather than re-summed by every later request. Provider billing fields, system prompts, and tool schemas are not available in these local records, so those totals and costs are marked `estimated` and are not exact provider token billing. Costs are estimated from the models.dev catalog for each mapped model; the adapter may break if Qoder changes its on-disk format.

One figure in that record is not an estimate. Qoder bills in credits rather than tokens — it leaves every token field of its usage block at `0` and publishes an exact per-request `credits` amount beside them — so a Qoder tool row shows real credit consumption next to its `~`-marked tokens and cost. Credits cover exactly what Qoder usage covers, which is the Day / Month / Total tabs: the Yesterday and Week custom ranges do not include Qoder at all today (that scan covers Tokscale-backed tools plus Proma and Claude Desktop), and a Hub range answered from stored history reports no credits either.

#### Qoder account limits

`qoder` quota accounts are added manually to the Hub, separately from the local usage adapters above. The Hub encrypts the supplied credential, refreshes the account quota, and distributes the normalized result to connected devices. Device-side automatic discovery of local Qoder logins, browser profiles, environment credentials, and CLI accounts is removed; the device never uploads those credentials or treats them as quota sources.
</details>

## Adding a tool to this list

A tracked client is wired in one place — `TRACKED_CLIENTS` in `src/shared/clientTracking.js` —
and every surface has to agree on the id: watch paths, name normalization, labels and colours,
icon assets, WSL discovery, this matrix, and its guards. `AGENTS.md` lists the touch points.
Self-synced clients (Cursor, Antigravity) refresh their own tokscale cache, so their rows
describe a cache directory rather than the vendor's own data root.
