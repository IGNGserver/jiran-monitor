// A small, memory-only detail cache. A response belongs to the snapshot revision
// that requested it, never to a later device/period selection or another login.
export function detailRequest(stats, prefs) {
  if (stats?.detail !== 'summary') return null;
  const selected = stats.devices?.find((device) => device.deviceId === prefs.selectedDeviceId);
  const first = [...(stats.devices || [])].sort((a, b) =>
    Number(b.periods?.[prefs.period || 'today']?.totalTokens || 0) - Number(a.periods?.[prefs.period || 'today']?.totalTokens || 0)
    || String(a.hostname || a.deviceId).localeCompare(String(b.hostname || b.deviceId)))[0];
  const filter = stats.devices?.find((device) => device.deviceId === prefs.deviceFilter);
  const deviceId = filter?.deviceId || (prefs.view === 'devices' ? selected?.deviceId || first?.deviceId : '');
  const period = prefs.period || 'today';
  const revision = JSON.stringify([stats.updatedAt, stats.historyRevision, stats.deviceHistoryRevision,
    stats.devices?.map((device) => [device.deviceId, device.updatedAt, device.stale])]);
  if (deviceId) return { key: `${revision}:device:${deviceId}`, deviceId, path: `/api/devices/${encodeURIComponent(deviceId)}` };
  if (prefs.view === 'usage' && prefs.usageTab === 'sessions' && ['today', 'month', 'allTime'].includes(period)) {
    return { key: `${revision}:sessions:${period}`, period, path: `/api/sessions?period=${period}` };
  }
  return null;
}

export function createDetailCache(request) {
  const entries = new Map();
  let generation = 0;
  return {
    get(spec) { return spec ? entries.get(spec.key) : null; },
    clear() {
      generation++;
      for (const entry of entries.values()) entry.controller?.abort();
      entries.clear();
    },
    load(spec) {
      if (!spec) return Promise.resolve();
      if (entries.has(spec.key)) return entries.get(spec.key).promise;
      // Evict oldest documents, never retain an unbounded session/device history.
      while (entries.size >= 8) {
        const key = entries.keys().next().value;
        entries.get(key).controller?.abort();
        entries.delete(key);
      }
      const current = generation;
      const entry = { controller: new AbortController(), data: null, error: null };
      entries.set(spec.key, entry);
      entry.promise = Promise.resolve().then(() => request(spec.path, { signal: entry.controller.signal })).then((data) => {
        if (spec.deviceId && (data?.device?.deviceId !== spec.deviceId || !data.device.periods)) throw new Error('bad_device_detail');
        if (spec.period && !Array.isArray(data?.sessions)) throw new Error('bad_session_list');
        if (generation === current) entry.data = data;
      }).catch((error) => {
        if (generation === current) entry.error = error;
      });
      return entry.promise;
    }
  };
}

export function withStatsDetail(stats, spec, data) {
  if (!data || !spec) return stats;
  if (spec.deviceId && data.device) {
    return { ...stats, devices: stats.devices.map((device) => device.deviceId === spec.deviceId ? data.device : device) };
  }
  if (spec.period && Array.isArray(data.sessions)) {
    const sessions = Object.fromEntries(data.sessions.map((session, index) => [session.key || session.id || String(index), session]));
    return { ...stats, periods: { ...stats.periods, [spec.period]: { ...stats.periods[spec.period], sessions, sessionsTotal: data.total } } };
  }
  return stats;
}
