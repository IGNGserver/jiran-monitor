# Remote database latency: budget and decisions

This note records why the Hub's MySQL link is shaped the way it is, what was
changed for a high-RTT deployment, and which cache/schema ideas were evaluated
and rejected. It is a design record, not a benchmark report: the numbers below
are statement counts and payload bounds derived from the code, not measurements
from a real WAN link. Reproduce with the procedure at the end before claiming a
latency improvement on a specific deployment.

## Topology and the two costs

The only database client in the product is the Docker Compose Hub. The desktop
app and the headless agent talk HTTP to the Hub and never open MySQL.

```
device ──HTTP──▶ Hub ──MySQL──▶ database server
browser/phone ──HTTP──▶ Hub
```

Two links can be slow, and they need different fixes:

1. **Hub ↔ database** (the subject of this note). Reads are served from the
   in-process fleet read model after the first load; the recurring cost is the
   per-device ingest write, plus the one cold fleet load.
2. **Device ↔ Hub / client ↔ Hub** (HTTP). Payload size is bounded by the 1 MiB
   request cap, and reads are compressed. A slow client does not stall the
   database.

## Per-ingest round-trip budget

`src/hub/server.js` (`ingest`) and `src/hub/repository.js` now issue this steady
state sequence inside one transaction (pricing cached, sessions diffed against the
persisted display document):

| # | Round trip | Notes |
|---|---|---|
| 1 | `BEGIN` | |
| 2 | `lockAndLoadIngestState` | one `SELECT ... FOR UPDATE` over device + display + baseline |
| 3 | `UPDATE devices` | metadata; `history` only when it changed |
| 4 | `device_ingest_state` patch | `JSON_SET`/`JSON_REMOVE` of changed top-level keys |
| 5 | `device_ingest_baseline` patch | same, only when the raw baseline moved |
| 6 | `INSERT usage_events` | batched (500 rows / 512 KiB per statement) |
| 7 | session upsert | only changed rows; the read is skipped on the normal path |
| 8 | `COMMIT` | |

That is **8 round trips** (9 on the first tick that has to load a model's price,
plus extra batches for very large deltas). Before this pass it was 11–14: the
lock, display and baseline were three statements, pricing was read every tick,
the session diff always read the whole table, and any changed key rewrote the
whole JSON document.

At a 50 ms RTT the write costs about 0.4 s; at 100 ms, 0.8 s; at 200 ms, 1.6 s.
The device row lock and one pool connection are held for that duration, which is
why `MYSQL_CONNECTION_LIMIT` and upload cadence matter more than raw bandwidth at
small fleet sizes.

### Why not fewer than eight

The four writes are separate tables, and mysql2 does not pipeline statements on
one connection. Collapsing them would require `multipleStatements` (one text
protocol call carrying three statements), which widens the SQL-injection surface
for a two-round-trip gain; it is deliberately not used. A stored procedure would
move the same logic into the schema and complicate migrations and tests.

## Bytes, not just round trips

`device_ingest_state.snapshot_json` holds the normalized device record: three
periods (each with that period's session map) plus the history document. The raw
baseline is a second copy. The request body is capped at 1 MiB
(`src/shared/wireValidation.js`), so a heavy device is bounded but still
hundreds of KiB; a synthetic 1200-session / 180-day record serializes to roughly
700 KiB, of which the session maps are the bulk and history is a few percent.

The incremental snapshot write removes history and attribution from every tick
that does not change them, but it cannot avoid re-sending `periods` because the
session counters live there. The sessions table write is already a diff.

Making the bytes small would mean making `sessions` the authoritative store and
projecting `periods.*.sessions` on read (a per-period session table) — a schema
change that touches ingest, transfer re-anchoring, cold-start assembly and the
wire contract. It is **deferred** with these criteria:

- a real profile shows snapshot bytes (not RTT) dominate ingest on the target
  link; and
- the fleet has enough sessions per period that the diff is materially smaller
  than the document; and
- a migration plus transfer/reanchor parity tests and a before/after benchmark
  exist. No production data migration is part of this pass.

## Cold start

The first fleet read is one `SELECT state.snapshot_json ... JOIN devices` over
all active devices, followed by normalization. On a remote link it is the sum of
every device snapshot, so it is the slowest single read. The read is latched
(`fleet.getRecords()` shares one in-flight promise), so concurrent first requests
do not multiply it; that is the only cold-start mechanism in this pass.

A **warm-start file cache** was evaluated and rejected. A cache written after
commit can lag by its debounce window (or crash window), and the read model has
no way to tell a client "this fleet is from the cache". Serving it as current
would repeat the class of bug the project already fixed elsewhere (a cached
period printed under the wrong tab). An eager prewarm at listen time was also
evaluated and removed: it only overlaps the read with the client's connection,
while making the fleet snapshot depend on startup timing (a repository write
between `start()` and the first request becomes invisible until the next ingest).
Revisit a cache only if a fleet-level staleness flag can be carried through
`/api/stats`, SSE and the UI, and the cache can be invalidated by a monotonic
revision row rather than by trust.

## Range answers

`/api/usage/range` still queries `usage_events` on every request. A 30-second
payload cache was implemented and then removed: the ledger is append-only, but a
repository can be written outside the Hub process (a migration, a manual
correction, a test), and the cache would then report a total that disagrees with
the source of truth. The window is a user action, not a hot path. A cache keyed
by `MAX(usage_events.id)` would be correct for inserts but still adds a round
trip; it is not worth it for this call frequency.

## Redis

| Use | Verdict | Reason |
|---|---|---|
| Hot fleet reads | No | The normalized fleet is already in process; Redis adds a hop, serialization and a failure domain. |
| Cold start | No | A file cache has the same staleness problem; Redis only helps with multiple replicas or no volume. |
| Multiple Hub replicas on one schema | Would need it (or a revision table) | The read model is per-process; invalidations and SSE would have to fan out. The product boundary is a single Compose stack. |
| Shared rate limits / sessions | Only with replicas | In-process state is sufficient for one Hub. |
| Ingest write buffering | No | Moves the "committed" meaning from MySQL to Redis and forces reads to merge unflushed data. |

If multiple Hub processes ever become a supported topology, the first step should
be a `hub_state(fleet_revision)` row polled by each process (no new service,
restart-safe), not Redis. A `JIRAN_CACHE_URL` adapter belongs after that decision,
scoped to cold-start snapshots and invalidation, never to the aggregate itself.

## Operating a remote database

- Keep the Hub close to MySQL when possible; a LAN/VPN hop is what turns 8
  round trips into a visible delay.
- `MYSQL_CONNECTION_LIMIT` 5–10 per Hub, `MYSQL_MAX_IDLE=2`,
  `MYSQL_IDLE_TIMEOUT_MS=30000`; several apps on one server multiply the pool.
- `MYSQL_SLOW_QUERY_MS` (default 1000, `0` disables) logs the SQL text of slow
  statements; values are never logged.
- `GET /api/health` reports `storage.latencyMs` and answers 503 when MySQL is
  unreachable; `getResourceMetrics()` exposes pool totals and query counters for
  the process.
- Startup and migrations retry transient connection failures with bounded
  backoff. A transaction that already sent `COMMIT` is never retried.

## Reproduce a latency profile

Use a disposable MySQL and a latency proxy in front of it (toxiproxy, or `tc
netem` on a Linux host). Keep the dataset small enough to reason about and take
three measurements per setting:

1. Cold start: start the Hub, request `/api/stats` once, read `Server-Timing` and
   `storage.latencyMs`.
2. Steady write: ingest one cumulative snapshot per second with
   `Prefer: return=minimal`, then read the pool counters and the slow-query log.
3. Range: request `/api/usage/range` over the same window twice, confirm both
   queries hit MySQL (no payload cache) and record the query duration.

Add 25/50/100/200 ms each way and compare `ingest` p50/p95, cold-start time and
pool queue depth. Do not compare against the memory-repository numbers in
`hub-resources.md`; that harness isolates CPU, not I/O.
