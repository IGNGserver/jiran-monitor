# Cross-platform loading rollout

## Baseline (2026-10-20)

Read-only samples against the deployed 1.2.6 Hub (five devices) found a full stats response of approximately 1.08 MB decoded / 166 KB gzip, versus 110 KB / 19 KB for the existing summary. Full SSE first frames were approximately 1.08 MB without compression. Repeated loopback reads returned identical headline totals for both shapes. These are diagnostic samples, not percentiles or a benchmark of every client.

The Cloudflare browser trace started health/rates requests at approximately 10.18 seconds after navigation; the unauthenticated connection gate became available after approximately 11.39 seconds. A Beijing FRP trace started those requests at approximately 1.82 seconds. The original report of an unusable Beijing connection was not reproduced. The local Cloudflare route used a proxy/Fake-IP and SJC/LAX edges; it is not a substitute for the affected user's mobile network. The Beijing entry was public HTTP, without Service Worker support.

## Sequence and acceptance

1. Instrument shell, authorization, first snapshot and first live data with bounded local User Timing marks; expose application response duration with `Server-Timing`. No telemetry service, payload logging or credential logging.
2. Remove duplicate startup stats, stop waiting for optional rates, repair the rates cache, and load only documents the selected page needs.
3. Use capability-negotiated summary REST/SSE across all remote clients, with explicit device/session detail reads and an old-Hub fallback. Summary and full responses must preserve headline totals and provenance.
4. Bundle critical web modules using a maintained build tool; content-address resources, compress static responses and implement conditional reads. Generate the PWA resource graph, use a bounded navigation fallback and isolate version caches. Never cache authenticated API bodies in the Service Worker.
5. Repair stream cancellation/reconnection, bound buffering, provide lightweight REST fallback and test lifecycle changes on Android and desktop. Keep collection outside Electron's main process and preserve hidden-window coalescing.

The current five-device fixture budgets are 30 KB gzip for the summary and 150 KB for a slim SSE first frame. Synthetic network goals are a usable shell within 2 seconds and first stats within 5 seconds at the documented test profile; real entry points must separately report success rate and percentiles. An installed, fully cached PWA should render its shell within 1 second offline, without pretending stale or missing data is live.

## Reproduction and deployment boundary

Run `node scripts/measure-loading.js https://your-hub.example 3` from each affected network. Protected reads require `JIRAN_BENCH_SECRET` in the process environment; the script rejects credentials in URLs and authenticated public HTTP. Use an SSH-forwarded loopback endpoint for the current HTTP FRP deployment. Output contains paths, timing, response sizes and status codes, not usage values or secrets. Browser Performance entries named `jiran:loading:*` complement this network-only probe. `Server-Timing` measures server processing before response transmission, not Internet latency.

Code integration does not deploy or publish. Production HTTPS termination for the Beijing entry and Cloudflare cache-rule corrections require a separately authorized infrastructure change. HTML and the Service Worker must not inherit a long-lived edge cache rule; only content-addressed public resources may be immutable. API traffic must bypass shared caching. Keep old hashed assets available while old clients remain open; do not purge active version directories during an update.

Android/desktop release-equivalent startup, Safari installed-PWA, offline upgrade, and the user's failing mobile route require explicit device acceptance; Node/JVM checks cannot prove those timings.

## Implemented code path

The browser build uses pinned esbuild-wasm as a development-only dependency, rather than a custom module concatenator or a new application framework. The WASM distribution avoids native install scripts across the CI platform matrix. `npm run build:web` generates `dist/web`, which is copied by the Docker web-assets stage. Source-mode development stays supported, but its intentionally inert Service Worker is not an offline release. Desktop continues to load source ESM; both transports share the bounded linear frame splitter.

New summary responses carry `detail: "summary"`; clients also recognize older staged Hubs whose projection predates that marker. Device detail is revision-keyed and only requested for a selected device/filter. Session responses retain their original map key and total count, so the existing capped display and token-component metrics remain intact. Unknown/older Hubs retain the full stats path. Remote desktop summaries remain Hub-authoritative instead of re-aggregating partial device maps with this machine's unposted local data.

The PWA precaches only the critical output graph atomically. Public icons and installation metadata are ordinary HTTP resources rather than prerequisites for an offline application shell. Hashed bundles do not background-revalidate on each visit. Existing tabs stay on their complete cached version until closed; activation only deletes this application's old caches and never forces a mid-session version takeover. A production edge rule that caches stable HTML/SW contrary to origin headers still needs correction outside this code change.

## Local acceptance samples (not production percentiles)

A five-device synthetic in-memory Hub, served from the production browser build, was exercised with installed headless Chromium on macOS. A fresh desktop context recorded shell/authorization/snapshot/live initialization marks at 313/440/576/626 ms, issued one summary REST read plus slim SSE (no full stats read), and rendered the overview without script errors. Device drill-down fetched one device document. The session screen preserved the cap notice (200 of 220 synthetic rows). A controlled, installed Service Worker reopened the shell offline in 292 ms with no page script errors. These are one-run functional samples, not a desktop release or installed Safari-PWA certification.

Three fresh mobile contexts at 150 ms simulated network latency, 200,000 bytes/s download, 100,000 bytes/s upload and 4× CPU throttling, with rates deliberately unavailable, recorded shell initialization at 2270/2272/2206 ms and first snapshot at 3151/3059/3168 ms. There were no uncaught page errors. The 5-second first-stats target passed in this synthetic profile; the 2-second initialization target did not. User Timing initialization marks are not equivalent to the browser's first paint. This fixture is much smaller than the production fleet and this local simulation is not comparable to the earlier authenticated Cloudflare WAN sample. Real-device, real-entry-point percentile and payload-budget acceptance remains outstanding.
