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
