# Android home-screen widgets

Four widget receivers expose the Hub's headline numbers without making the
launcher a second copy of the app. The surface is deliberately **read-mostly**:
it answers "what is happening right now?" and sends the user to the page that can
change something.

## The family

| Widget | Sizes | Answers | Default tap target |
| --- | --- | --- | --- |
| Today | 2×2, 4×2 | How much did I use today, and how does it compare with yesterday? | Overview |
| Limits | 2×2, 4×2 | Which quota is closest to running out, and when does it reset? | Service status |
| Trend | 4×2 | What has the last seven days looked like? | Analytics |
| Dashboard | 4×4 | Everything above in one card. | Overview |

The 2×2 variants answer exactly one question. The 4×2 variants add the second
layer (footer totals, three quota rows, a labelled chart). The launcher decides
the cell size; `WidgetSizing` maps the measured `minWidth/minHeight` to the
layout, and `onAppWidgetOptionsChanged` re-renders on a resize.

## Data path

```
Hub /api/stats/summary (+ /api/rates when the display currency is not USD)
        │  fallback: /api/stats on a Hub without statsSummary
        ▼
WidgetSnapshotMapper  (pure Kotlin, DTO → small document)
        ▼
WidgetSnapshotStore   (app-private JSON, atomic write)
        ▼
WidgetRenderer        (RemoteViews + Canvas bitmaps)
```

`/api/stats/summary` is the same aggregate the in-app first paint uses and
already contains `periods`, `limits` and `historyPreview`, so one request feeds
all four cards. The snapshot keeps:

- today / month / all-time tokens and USD cost, plus an aggregate estimate flag;
- yesterday and the trailing seven daily points (missing dates are zero-filled);
- one row per quota account, reduced to the highest-used window, with status,
  reset instant, balance fallback and a stable id;
- fleet online/total, display currency/rate, capture time, last attempt, error.

The document is the only render source. A killed process, a launcher restart or
an unreachable Hub therefore still shows the last known numbers with an honest
"updated X ago" line.

## Refresh

- One `WorkManager` periodic request for all widget instances, default 30
  minutes, configurable 15/30/60/180. `updatePeriodMillis` is 0 in every
  appwidget info so the platform alarm and WorkManager cannot double-fire.
- A network-connected constraint and exponential backoff; the platform may defer
  the run under Doze, and the UI says so rather than pretending to be live.
- A one-shot at 00:05 local time. The renderer also compares the snapshot's
  captured date with today and downgrades a stale card to "昨日数据".
- Adding a card, tapping refresh, or a successful foreground refresh publishes
  immediately. The foreground `HubViewModel` debounces SSE-driven publishes so a
  burst of frames writes one snapshot.
- No SSE in a widget: the stream belongs to a foreground screen.

## Rendering

RemoteViews, not Glance. The pieces that need real drawing — the rounded surface,
the seven-day chart, the quota ring and the progress bars — are Canvas bitmaps;
text remains native so font scaling and TalkBack still work. This keeps the
background path free of Compose and gives exact control over the Fluent hierarchy.

The palette is resolved at render time from the same `FluentLightColors` /
`FluentDarkColors` aliases and `FluentBrandSeeds` the app uses. Widget layouts
carry only platform-colour placeholders for the launcher picker; every live
surface, chart, ring and state colour comes from the measured alias set, so
`verify:android-fluent-contrast` remains the single measured source.
`ThemeSeedId.System` uses the measured default ramp, not a wallpaper accent that
no guard can measure.

## States

Every card distinguishes:

- **Fresh** — snapshot within two refresh intervals and captured today.
- **Stale** — older than two intervals, or captured on a previous day.
- **Offline** — the latest attempt failed but a previous document exists.
- **Empty** — configured, no document yet.
- **Unconfigured** — no Hub URL/secret.

Status is always text plus colour. A quota status word (expired credential,
provider rate-limit, fetch failure) replaces the useless percentage and removes
the progress fill instead of rendering a stale gauge.

## Privacy and security

- The snapshot contains aggregate numbers and display labels (provider, account,
  plan) only; no credential, token or secret ever leaves `ConnectionStore`.
- The refresh/metric receiver is non-exported. Its `PendingIntent`s are explicit
  and immutable. Whole-card taps carry a route name, not a URL or credential.
- "Hide cost" is global: every card shows `••••` instead of money.

## Verification

- JVM tests pin the mapper (periods, yesterday, zero-filled days, window choice,
  quota ordering, failure retention), copy/status decisions, and size
  breakpoints. Compose is not loadable in this suite, which is why the mapper and
  `WidgetCopy` are free of Compose types.
- `:app:assembleDebug` proves the manifest, four `appwidget-provider` XML files
  and all RemoteViews layouts link.
- Visual checks still need a launcher: light/dark, 2×2 vs 4×2 vs 4×4, resize,
  font scale, offline state, long-press reconfigure and the pinned-widget flow
  from 更多 → 小组件.
