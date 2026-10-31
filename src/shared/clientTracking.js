'use strict';

// The fixed set of wired client ids. Every wired harness is always tracked:
// the settings surface that used to select clients is gone, so this is not a
// `default` a runtime may override — the desktop app and the headless agent
// both pass exactly this list to the collector.
//
// micode (MiMo Code) is deliberately included even though mimocode.db imports
// Claude Code sessions and tokscale does not dedup those imports: every wired
// harness is tracked, and with no selection surface left there is no other way
// to reach MiMo data. The duplicated `claude` rows are a known upstream
// limitation. The two Qoder sites are local adapters whose token totals are
// reconstructed from content — the wire record marks them with
// `clientEstimated` while their credits are exact provider billing. No surface
// prefixes the reconstructed value with a marker.
//
// Adding a client means touching several spots that must agree on the id; the
// checklist lives in AGENTS.md ("Adding a tracked client").
const TRACKED_CLIENTS = 'claude,claude-desktop,codex,gemini,hermes,opencode,openclaw,cursor,antigravity,cline,kimi,qwen,grok,copilot,pi,zed,kilocode,roocode,commandcode,micode,zcode,kiro,codebuddy,workbuddy,proma,deepseek-harness,qoder,qodercn,reasonix,amp,droid,mux,kilo,crush,goose,codebuff,freebuff,trae,warp,gjc,jcode,junie,opencodereview,devin-cli,devin-desktop,senpi,augment,kimchi,prime-agent,cherrystudio,mcode,fx,lmstudio,unsloth,hindsight';

function normalizeClientsCsv(value) {
  return String(value ?? '').split(',').map((client) => client.trim().toLowerCase()).filter(Boolean).join(',');
}

module.exports = {
  TRACKED_CLIENTS,
  normalizeClientsCsv
};
