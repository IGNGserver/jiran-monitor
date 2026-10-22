'use strict';

const HUB_API_VERSION = 3;

function hubCapabilities(runtime, options = {}) {
  const hubAccounts = options.hubAccounts === true;
  return Object.freeze({
    stats: true,
    history: true,
    statsStream: true,
    subscriptions: true,
    usageRange: true,
    pricing: true,
    deviceDelete: true,
    deviceRename: true,
    publicStats: Boolean(options.publicStats),
    hubAccounts,
    centralLimits: hubAccounts,
    limitsAuthority: hubAccounts ? 'hub' : 'none',
    // Staged reads. A client that has them can ask for the first-paint summary
    // and pull session/device detail on demand instead of downloading it with
    // every fleet snapshot. Older Hubs omit the flags and their clients must
    // keep using `/api/stats` alone, so absence means "not available".
    statsSummary: true,
    deviceDetail: true,
    sessionList: true,
    // `/api/updates` resolves the newest installable Android release through the
    // Hub. Older Hubs omit the flag and the client must fall back to the release
    // page rather than treating a 404 as "no update".
    updateCheck: true
  });
}

module.exports = { HUB_API_VERSION, hubCapabilities };
