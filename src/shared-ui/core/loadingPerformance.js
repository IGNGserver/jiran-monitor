// Local-only, bounded User Timing entries. Never record URLs, credentials or usage.
const STAGES = new Set(['shell', 'authorized', 'snapshot', 'live']);
const completed = new Set();

export function markLoadingStage(stage, clock = globalThis.performance) {
  if (!STAGES.has(stage) || completed.has(stage) || !clock?.mark) return;
  completed.add(stage);
  clock.mark(`jiran:loading:${stage}`);
}
