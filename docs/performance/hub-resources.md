# Isolated Hub resource measurements

## Implemented stages and decision

1. **Baseline/correctness:** fixed-seed isolated HTTP/SSE workload and regression
   tests for raw transfer baselines, repeated uploads, rollover, publication races
   and post-commit response failures. Durable acceptance never depends on a
   successful stats rebuild.
2. **Write amplification:** bounded multi-row ledger writes, session differences,
   one grouped range scan, shared snapshot serialization, unchanged-history skips
   and timestamp-only JSON patches against the actual persisted display/raw data.
3. **Read model/publication:** retain normalized device contributions, update only
   the committed device, separate usage/history/limits/subscription invalidation,
   lazy full sessions, summary without session folding, scoped revisions and
   calendar/presence deadlines. A snapshot uses one source set and clock instant.
   Publication has one builder and one dirty marker; a completed version is
   published even if more writes arrive. It yields at most 250 ms to in-progress
   legacy full REST reads to avoid concurrently duplicating multi-megabyte output.
4. **Background/memory bounds:** shared probe permits/versioned single-flight,
   due/disabled skips, failure backoff, credential-safe bounded provider caches,
   body-inclusive update deadlines/size budgets and checksum caching. JSON byte
   representations are shared by REST/SSE with bounded retention/compression;
   builds precompress static assets and sessions load active rows only.
5. **Storage/language evaluation:** keep Node + MySQL. SQLite/Go are disposable
   experiments, not production adapters. The durable three-table CI comparison
   strengthens the initial microbenchmark, but is not a full-backend parity test
   or evidence for migrating user data. No runtime dependencies were added.

The read model replaces individual contributions, but still folds the fleet on a
real usage change; it is not a fully incremental numeric/session accumulator.
Full compatibility responses still contain the complete archives. Further hot/cold
schema separation or a new database/runtime requires whole-stack profiles and the
parity/fault tests below rather than extrapolation from JSON timings.

No production deployment or data migration is part of this change. NAS physical
IO, long-running RSS/GC plateaus, real provider traffic, phone/browser acceptance
and crash/power-loss testing remain rollout gates, not completed measurements.

## Scope and safety

### Final local mechanism comparison (2026-10-24)

The frozen driver and repository harness hashes match across
`baseline-resources-final.json` and `current-resources-final.json`; fixture SHA-256
is `cd6a1c8a91e466ffa14ac991a875070454d75706ec41fdabb46e7dd439c9c399`.
Both use Node 24.18.0 on macOS, 40 sessions/device/period, a 250 ms target interval
and 10 seconds per fleet size. Each closed-loop round performs a minimal ingest,
summary read and full read while both slim and full SSE consumers are connected.
The memory repository is identical, not the production MySQL implementation.

| Devices | Rounds, before → after | Ingest p50 ms | Summary p50 ms | Full p50 ms | CPU ms/round | Sampled peak RSS MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 40 → 41 | 24.32 → 15.00 | 1.25 → 2.67 | 1.81 → 4.18 | 37.61 → 32.74 | 128.41 → 129.04 |
| 5 | 41 → 40 | 50.39 → 14.14 | 5.95 → 2.98 | 5.90 → 12.22 | 73.72 → 43.06 | 173.97 → 180.45 |
| 20 | 39 → 40 | 163.03 → 15.33 | 57.89 → 4.08 | 23.16 → 46.68 | 217.22 → 89.40 | 290.20 → 308.48 |
| 50 | 15 → 22 | 392.04 → 24.14 | 183.56 → 19.38 | 151.28 → 138.88 | 541.51 → 197.45 | 421.13 → 388.53 |

Measured fleet-list reads drop from one per round to **zero** after warmup, not
because durability is deferred but because committed normalized contributions
replace the cached device directly. At 50 devices the measured CPU per completed
round is about 64% lower; the sampled RSS peak is about 8% lower. A separate
30-second baseline check (41 rounds) reported ingest/summary/full p50
400.48/186.40/147.42 ms, CPU 532.98 ms/round and sampled RSS 456.68 MiB.
The optimized 30-second confirmation completed 63 rounds, with p50
67.10/24.20/150.07 ms, CPU 202.85 ms/round, sampled RSS 388.34 MiB and zero fleet
list reads. The full-read median was effectively unchanged in this confirmation;
the larger benefits are minimal ingest, summary and CPU per completed round.

These results do **not** show uniform memory improvement: the 5/20-device peaks
increase, reflecting cache retention/GC and workload tradeoffs. Full reads at
small/medium fleet sizes pay lazy aggregation that was formerly charged to
ingest; they are not universally faster. An intermediate implementation exposed
a large-full-read/SSE overlap regression; sharing encoded JSON and bounded
publication yielding reduced its 50-device full p50 from about 502 ms to 139 ms.
The intermediate report is retained, not substituted for the final result.

This is a closed-loop test, not a fixed offered load: the slow baseline completes
fewer rounds, so compare CPU **per round** as well as elapsed utilization. Sample
counts are too small for stable p95/p99 claims, and RSS peaks are not long-run
plateaus. Host load, timing/order and GC are not controlled. There is no MySQL,
physical disk IO, provider probing, HTTP compression, TLS/auth or production data
in this workload. It supports the mechanisms, not a production resource/energy
percentage promise. Retained JSON reports live under local scratch; they are not
source/build artifacts on the NAS.

`scripts/benchmark-hub-resources.js` runs the real target Hub in a fresh child
process for each fleet size. The driver is a separate process; its HTTP parsing,
fixture generation and SSE consumption do not enter the Hub CPU/memory counters.
Both processes still share the host CPU, so this is not a dedicated-runner result.
There is no production endpoint option, credential input, provider account, real
usage log, migration or production database. The Hub binds an ephemeral loopback
port, receives an injected `MemoryRepository`, disables account probing, and has
outgoing socket connections and `fetch` blocked. The worker receives an allowlist
of environment variables, not the caller's Jiran/MySQL/provider/proxy settings.

Output defaults to `$BUILD_SCRATCH_ROOT/jiran/hub-resource-benchmarks/` (default
root: `~/.build`). Explicit output must remain under that scratch root; existing
files, symlink escapes, the project volume and recognized NFS/SMB mounts are
rejected. The script requires at least 20 GiB free. Source and fixture files are
read-only. Run builds/tests from a local scratch snapshot too, not the NAS.
The filesystem checks are guards, not a sandbox against adversarial mount changes.

## Reproduce the P0 workload

Use Node 22.13+ with the target Hub's existing dependencies. No benchmark package
or additional dependency is needed. `NODE_PATH` can point a read-only baseline at
the current scratch snapshot's `node_modules`; do not copy dependencies onto NAS.

```sh
export BUILD_SCRATCH_ROOT="$HOME/.build"
export NODE_PATH="$BUILD_SCRATCH_ROOT/jiran/hub-resource-optimization/current/node_modules"
node scripts/benchmark-hub-resources.js \
  --source="$BUILD_SCRATCH_ROOT/jiran/hub-resource-optimization/baseline" \
  --devices=1,5,20,50 --sessions=40 --duration=30 --interval=250 --seed=613 \
  --output="$BUILD_SCRATCH_ROOT/jiran/hub-resource-optimization/baseline-long.json"
node scripts/benchmark-hub-resources.js \
  --source="$BUILD_SCRATCH_ROOT/jiran/hub-resource-optimization/current" \
  --devices=1,5,20,50 --sessions=40 --duration=30 --interval=250 --seed=613 \
  --output="$BUILD_SCRATCH_ROOT/jiran/hub-resource-optimization/current-long.json"
```

`--duration` is seconds **per fleet**, not a total time budget (0.1–3600).
`--devices` accepts a comma-separated matrix of 1–50 devices; `--sessions` is
0–200 per device per period. `--interval` is the target round interval in ms
(0 means unpaced). `--epoch` defaults to `2026-10-24T12:00:00.000Z`; the isolated
worker clock advances monotonically from that epoch, with UTC fleet buckets.
It is not frozen: TTLs, stale thresholds and heartbeat behavior still advance.
Avoid crossing a calendar boundary when comparing runs.

The fixed-seed fixture has device-scoped sessions, project rollups, 30 daily
history rows and their monthly tier. Each period deliberately uses the same
session archive and counters; this is a repeatable shape/size workload, not a
realistic lifetime/day distribution. Fixture hashes are recorded, along with
representative target source hashes and the driver/repository harness hashes.
Freeze **the same harness snapshot** for both runs. In particular, changing the
test `MemoryRepository` between runs invalidates a comparison even if the seed
matches. The target source hash set is diagnostic, not a complete build identity;
also retain the target Git revision externally.

Seeding is excluded from measurement. Summary and full reads are warmed once,
then one slim and one full SSE connection are opened. Every measured round:

1. Posts one rotating device with changed counters, one advanced session and
   `Prefer: return=minimal`. Session increments exercise the actual ingest ledger
   delta path, rather than only changing headline totals.
2. Reads `/api/stats/summary` and `/api/stats`, sequentially.
3. Consumes both SSE streams continuously; heartbeat frames are counted too.

All HTTP requests require status 200. Compression is deliberately disabled
(`Accept-Encoding: identity`). The number of devices does **not** multiply the
arrival rate: this isolates fleet-size cost at one rotating ingest per round.
The load is closed-loop; a slow round lowers throughput rather than queuing
unbounded work. Report both rounds and measured duration, not CPU alone. Work
already in flight is allowed to finish, so the actual duration can exceed the
requested duration. There is a 25 ms stream-drain allowance, not an end-to-end
delivery guarantee. Do not interpret it as slow-client/backpressure testing.

### Report semantics

- `cpuMicroseconds`: Hub `process.cpuUsage()` delta. `cpuOneCorePercent` is
  user+system CPU divided by elapsed wall time; 100% means one core, not the host.
- `memoryBytes`: `process.memoryUsage()` before/after and 50 ms sampled peaks,
  including RSS, heap, external memory and array buffers. Short spikes can be
  missed; garbage collection is not forced. This is not a leak/soak test.
  The in-memory repository also retains synthetic stored rows/events in the Hub
  process, unlike an external MySQL database; RSS is not a production forecast.
- `resourceUsage`: cumulative `process.resourceUsage()` and interval deltas.
  `maxRSS` is a lifetime KiB high-water mark, including setup, not a delta.
  These counters are not MySQL-container or machine-wide resource usage.
- `eventLoopMs`: `monitorEventLoopDelay()` p50/p95/p99/max, histogram sample count
  and 10 ms resolution. The resolution contributes to the observed baseline;
  this is not a direct per-request blocking-time measurement.
- `repositoryCalls`: counted method invocations, including nested calls, after
  warmup. **Not SQL statement counts or database IO.** The fake does not model
  locks, MySQL network/commit latency, pool pressure or SQL execution plans.
- `requests`: completion latency in milliseconds through full body consumption,
  nearest-rank percentiles, exact sample count, total and mean body bytes.
  Headers, TCP and HTTP chunk framing are excluded from bytes. No body is stored.
- `sse`: measured body bytes and event counts by shape, separate initial snapshot
  setup metrics and stream errors. SSE update latency is **not measured**; REST
  latency must not be relabeled as SSE delivery latency.

Small-sample tails are descriptive. The report flags fewer than 100 samples;
even 100 is not a p99 confidence interval. Repeat paired runs with reversed
ordering on an otherwise idle host and report the spread. Longer runs are
necessary for stable tails, idle behavior, memory retention and realistic fanout.
Do not extrapolate this benchmark to provider scheduling or MySQL optimizations.

## First baseline evidence (before service edits)

The initial smoke baseline used `origin/main` revision `30586ba`, Node v24.18.0,
macOS x64, 40 sessions, seed 613, 250 ms round interval and 5 s per fleet. The raw
report is retained locally as
`~/.build/jiran/hub-resource-optimization/baseline-resources.json`; it is not a
repository artifact. The short run predates the additional harness hash fields
and advanced headline counters only, not archived sessions; it is an early
resource smoke reference, not the final ledger-delta comparison workload.

| Devices | Completed rounds / samples per REST route | CPU, one core | Sampled peak RSS, MiB | Ingest p50, ms | Summary p50, ms | Full p50, ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 20 | 23.3% | 120.9 | 24.90 | 1.75 | 1.84 |
| 5 | 20 | 40.9% | 163.5 | 58.95 | 8.80 | 6.15 |
| 20 | 20 | 82.3% | 285.6 | 161.28 | 53.72 | 23.29 |
| 50 | 7 | 73.9% | 352.7 | 395.84 | 182.32 | 155.27 |

The 50-device CPU percentage is lower despite slower requests because the
closed-loop arrival rate dropped. This is not evidence that a larger fleet
costs less. Baseline `listDeviceRecords` calls equaled completed rounds. The full
response averaged approximately 5.59 MB at 50 devices. All four tails have too
few samples for an acceptance decision. Re-run baseline and candidate with a
frozen final harness before publishing a before/after claim.

A subsequent baseline-only run with the final session-delta workload is retained
as `baseline-resources-final.json`: 10 s per fleet, respectively 40/41/39/15
completed rounds for 1/5/20/50 devices. At 50 devices it observed 392.04 ms ingest
p50, 183.56 ms summary p50, 151.28 ms full p50, 75.8% of one CPU core and
421.1 MiB sampled peak RSS. Both SSE shapes received 15 stats frames. These are
still short-run observations, not stable tail estimates. The frozen local
`benchmark-tools/` harness can target both the immutable baseline and current
scratch source; its driver SHA-256 is
`331a988cc342fdc06431bccdbe3cadbc3c548d1107055decf6cca9373efb7994`, and
its repository harness SHA-256 is
`1b0e8da81475b14deba5aa57dc5c657fbf0da83c2256b3a17dd07e1f6694c0e2`.

## P5: storage and runtime experiments, not a replacement proposal

`scripts/experiments/hub-resource-comparison/run-comparison.js` uses exactly the
same `makeFixture()` input. It writes a synthetic JSON fixture, a disposable
SQLite file and a Go executable **only in local scratch**. Existing outputs are
never overwritten. It installs no tool or dependency and never contacts MySQL.

```sh
node scripts/experiments/hub-resource-comparison/run-comparison.js \
  --devices=20 --sessions=40 --seed=613 --iterations=100 \
  --output="$HOME/.build/jiran/hub-resource-optimization/comparison-20.json"
```

The Node baseline decodes JSON, sums primitive totals/client/model counters and
encodes the resulting JSON. The Go standard-library prototype does the same
primitive projection from identical input bytes, but uses typed decoding: it
scans unknown sessions/history without allocating their object trees. Therefore
the byte input and output measurements match, **not the allocation workload**.
Both omit real Hub normalization, session/history merging, provenance, cache
invalidation, authentication, HTTP/SSE and compression. Five warmup iterations
precede aggregation samples. Go compilation is excluded from timings; `GOCACHE`
and `GOPATH` live under `BUILD_SCRATCH_ROOT`, with automatic downloads disabled.

The SQLite slice stores one JSON snapshot per device, with one local connection,
`journal_mode=WAL`, `synchronous=FULL`, and autocommitted single-device writes.
Every measured write changes `updatedAt`; it is not an identical-value no-op.
Reads select every row, decode, aggregate and encode. The report records actual
SQLite version/source, pragmas, checkpoint status and a close/reopen total check.
There is no SQL schema equivalent to the Hub's ledger/sessions/auth tables, no
foreign-key/transaction parity, no concurrent reader/writer process, no crash or
power-loss validation, and no real database comparison. A successful reopen
does **not** establish freedom from SQLite WAL bugs. Record any failure, do not
disable WAL/FULL to manufacture a win, and audit the exact bundled SQLite build
and concurrency bug advisories before any wider durability experiment.

### Recorded local microbenchmark

On the same macOS/Node host, Go 1.24.4 and bundled SQLite 3.53.1
(`sqlite_source_id` starts `2026-05-05 ... c88b22011a54`), the 20-device / 40-session
fixture was 951,531 bytes, SHA-256
`b6864f00d13a29d47b03170627d55107ca1f76d5c4ff54fcb3b8e7e85282da1a`.
The retained `comparison-20.json` reports 100 samples for each row:

| Operation | p50, ms | p95, ms | What it includes |
| --- | --- | --- | --- |
| Node JSON projection | 6.35 | 9.03 | Decode all fields, primitive sum, encode |
| SQLite snapshot write | 0.64 | 1.02 | One changed row, autocommit WAL/FULL, small JS timestamp mutation |
| SQLite fleet read | 6.23 | 6.71 | All snapshots, JS decode/sum/encode |
| Go JSON projection | 10.22 | 13.89 | Typed decode, primitive sum, encode |

Totals matched across Node, SQLite reads/reopen and Go. The local SQLite
checkpoint reported no busy reader, and no error was observed in this narrow
single-connection test. No WAL concurrency safety claim follows. Go was slower
in this particular JSON slice despite decoding fewer fields; that neither proves
Node is universally faster nor supports a Go rewrite. The SQLite write number
has **no MySQL comparator**: this machine had no isolated MySQL setup or Docker,
and no MySQL tooling was used. The report explicitly marks MySQL unmeasured.
Timing and CPU are not measurements of watts or energy consumption.

### Required next experiment before an architectural decision

Keep MySQL as the production backend. On an explicitly authorized disposable
local/CI database, implement equivalent device + ingest-baseline + event-ledger
+ session transactions for MySQL and SQLite. Use the same fixture hash, deltas,
indexes, retention, readers and durability acknowledgments. Count SQL statements,
commits, fsync/IO where supported, checkpoint stalls, lock waits, write errors and
RSS for the **whole stack**. Test restart/replay, rollback, reset/delete/rename/
transfer, concurrent ingest and long readers. Verify full API/SSE responses
against the Node Hub, not just headline totals. Only then compare deployment
resources and operational limits. A Go vertical slice needs the same correctness
and protocol parity before any full-Hub resource claim. No user data is migrated
by these experiments.

## Opt-in disposable CI MySQL/SQLite three-table slice

The stronger `scripts/experiments/hub-resource-comparison/mysql-slice.js` experiment
does **not** replace the single-row microbenchmark above. It uses identical
deterministic input for both engines, with three tables: a current snapshot, a
raw cumulative baseline and an append-only usage-event ledger. Every transaction
begins, reads/locks the raw baseline, upserts the snapshot, upserts the raw
baseline, appends one event and commits. ACK latency ends only when COMMIT
returns. No write is acknowledged before commit, and failures roll back all
three-table changes. Both engines use foreign keys and cached prepared data
statements; transaction/control queries are counted too.

### CI environment API

The caller provisions an **empty**, disposable schema and temporary user on its
isolated MySQL service before execution. The script never creates users/schemas,
changes global server settings, drops tables or connects to production. Any
pre-existing table causes a failure; use a fresh unique schema for every run.
All of these gates are required before any MySQL connection is opened:

| Variable | Required value |
| --- | --- |
| `JIRAN_DISPOSABLE_MYSQL` | Exactly `1` |
| `CI` | Exactly `true` |
| `JIRAN_MYSQL_HOST` | Exactly `127.0.0.1` or `localhost` |
| `JIRAN_MYSQL_PORT` | Optional TCP port, default `3306` |
| `JIRAN_MYSQL_DATABASE` | `jiran_ci_` plus 1–55 lowercase ASCII letters, digits or underscores |
| `JIRAN_MYSQL_USER` | Nonempty temporary-user name, environment only |
| `JIRAN_MYSQL_PASSWORD` | Nonempty temporary password, environment only |
| `BUILD_SCRATCH_ROOT` | Local output root; default `~/.build` |

Run with Node 24's built-in `node:sqlite` and the repository's existing `mysql2`.
Credentials are never accepted as CLI flags and are omitted from reports and
logs. Driver errors are reduced to safe error codes, not messages or connection
strings. Use the CI job's environment/secret mechanism, not an echoed shell
command containing credentials. If dependencies live in another scratch source
snapshot, set `NODE_PATH` to its `node_modules` as for the P0 driver.

```sh
node scripts/experiments/hub-resource-comparison/mysql-slice.js \
  --devices=20 --sessions=40 --iterations=100 --seed=613 \
  --output="$BUILD_SCRATCH_ROOT/mysql-slice.json"
```

This command runs only the storage slice, not Go or the mutable current Hub.
It writes the report and a retained SQLite file below local scratch. The same
output guards and free-space gate as P0 apply. MySQL tables remain in the
temporary CI schema until the disposable service is destroyed by the caller.

Without `JIRAN_DISPOSABLE_MYSQL=1`, only SQLite is measured and the report says
`mysql.measured=false`, `reason=not_opted_in`, `comparisonMeasured=false`.
An opted-in but unsafe/incomplete configuration, unavailable MySQL, durability
mismatch, SQL error or accounting mismatch makes the command exit nonzero with
`success=false`; the report still marks MySQL unmeasured rather than fabricating
results. A successful paired run has `success=true`, `comparisonMeasured=true`
and `crossBackendPayloadsMatch=true`. `success=true` alone can mean a successful
SQLite-only run; CI acceptance must also require `comparisonMeasured`.

### Accounting and durability contract

The fixed-seed fleet JSON matches the earlier fixture. Each transaction adds
synthetic `exactMeters` strings to its JSON snapshot. These are the authoritative
accounting fields for this slice, **not** a precision upgrade to production
floating-point period fields. Seed costs are derived exactly from token counts;
events add both token-derived costs and a `0.0000000001` USD component, with
ten-place fractional credit deltas. This deliberately detects precision loss.
The fixture and full transaction input have separate SHA-256 hashes.

SQLite stores tokens and scaled 1e-10 cost/credit integers in STRICT tables.
MySQL stores BIGINT tokens and `DECIMAL(24,10)` cost/credit values, with driver
big-number strings and `decimalNumbers=false`. Verifications use `BigInt` plus
decimal strings throughout, never Number arithmetic for tokens/cost/credits.
Every table's row count and exact totals must match the independently generated
expectation, and snapshot/raw-baseline JSON hashes must match each other and
across engines. SQLite close/reopen and MySQL connection reconnect must preserve
the same results. The raw baseline is checked inside each write transaction.

SQLite requires WAL and `synchronous=FULL`; `fullfsync` and
`checkpoint_fullfsync` are also enabled (their OS meaning varies). MySQL requires
`innodb_flush_log_at_trx_commit=1`, strict SQL mode and, when binary logging is
enabled, `sync_binlog=1`. Actual version/settings are recorded. InnoDB is
specified explicitly for all tables. These are corresponding durable-COMMIT
configuration requirements, **not proof of equal power-loss behavior** on
different filesystems, virtual disks or hardware caches.

### Output fields and limits

- Each backend's `writes.ackLatencyMs` records the exact sample count and
  percentiles (default 100), `commitsAcknowledged` and elapsed time.
- `sqlStatements` separates setup, seed, measured writes, metrics and validation.
  The normal measured path is **six SQL invocations per transaction**, 600 for
  100 samples. This does not count prepare/protocol messages, SQL internals or
  physical IO; it is not a query-execution-plan comparison.
- `beforeReopen` and `afterReopen` include exact totals/row counts for all three
  tables and a snapshot payload hash. `reopenReads.latencyMs` has 100 samples of
  complete three-table verification after **one** reconnect, not 100 restarts.
  These timings include JSON parsing, exact accumulation and hashing, not just
  database SELECT time.
- SQLite reports page count/size/free-list metrics. MySQL reports available
  global InnoDB/commit/status counters and before/after counter deltas where
  permitted; unavailable variables are absent, not assumed zero. Permission
  failures are reported explicitly. Global counters can include other clients;
  do not attribute them entirely to this slice.
- Client CPU includes SQLite's embedded engine but excludes the MySQL server.
  It is **not** comparable whole-stack CPU, RSS, energy or idle resource usage.
  SQLite runs first, so ordering/cache/host-load effects remain. No warmup writes
  are hidden: seeding is reported separately and all requested write samples
  are measured.

The local macOS SQLite-only run is retained as `storage-slice-local-final.json`, with
100 write ACK and 100 post-reopen verification samples. All three tables matched
tokens `4375884`, USD `4.3758840100`, credits `224.8148151870`; measured writes
used 600 SQL invocations. MySQL was explicitly **unmeasured**, not simulated.
This local run is not a SQLite/MySQL speed comparison. WAL concurrency, process
crash/server restart, power loss, real Hub transactions and multi-client load
remain outside this experiment. The isolated MySQL 8.4.8 CI service is the venue
for the actual paired measurement; do not fill in a MySQL result before it runs.

The first paired PR execution is now recorded in
[`hub-integration`, run 40090945053](https://github.com/IGNGserver/jiran-monitor/actions/runs/40090945053/job/120863298590):
real MySQL tests **5/5 passed**, including resumed transfers and timestamp/history
patches. The storage slice measured 100 durable COMMIT ACKs and 100 verification
reads after reconnect for each backend. SQLite 3.53.4 WAL/FULL write p50 was
**0.542 ms**; MySQL 8.4.8 InnoDB write p50 was **4.470 ms**. Snapshot/raw/ledger
counts and exact tokens, ten-place USD and credits matched before/after reconnect
and across backends (`success`, `comparisonMeasured`, `crossBackendPayloadsMatch`
were all true). This is the three-table slice on one disposable CI runner, not a
complete Hub adapter or a NAS deployment benchmark. It supports further SQLite
evaluation, not immediate migration or a whole-stack 8x performance claim. The
overall first CI run failed only the Windows benchmark worker-directory cleanup;
the driver now joins worker termination before returning, and the PR rerun is
the final cross-platform acceptance gate.

## Checks

In a local scratch source snapshot with the existing dependencies:

```sh
node --test tests/scripts/benchmarkHubResources.test.js tests/scripts/hubResourceComparison.test.js
node --test tests/scripts/mysqlSlice.test.js
node node_modules/eslint/bin/eslint.js scripts/benchmark-hub-resources.js scripts/experiments/hub-resource-comparison/run-comparison.js tests/scripts/benchmarkHubResources.test.js tests/scripts/hubResourceComparison.test.js
node node_modules/eslint/bin/eslint.js scripts/experiments/hub-resource-comparison/mysql-slice.js tests/scripts/mysqlSlice.test.js
```

These targeted checks cover reproducible fixtures, sample accounting, output
safety, repository instrumentation, an isolated real HTTP/SSE smoke run, the
experimental projection and cross-runtime comparison tolerances. They do not
replace the repository's full validation or real-MySQL tests.
