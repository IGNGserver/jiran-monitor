'use strict';

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyUsageRange() {
  // Kept field-for-field with repository.js's emptyUsageRange(): this fake is what
  // the range tests actually exercise, so a period field the real query sums has
  // to appear here too or a test can pass against a shape the Hub never returns.
  return {
    totalTokens: 0,
    costUsd: 0,
    clients: {},
    clientCosts: {},
    clientCredits: {},
    models: {},
    modelCosts: {},
    clientModels: {},
    clientModelCosts: {},
    eventCount: 0
  };
}

function addTokenCost(mapTokens, mapCosts, key, tokens, cost) {
  const id = String(key || '').trim() || 'unknown';
  mapTokens[id] = (mapTokens[id] || 0) + tokens;
  mapCosts[id] = (mapCosts[id] || 0) + cost;
}

class MemoryRepository {
  constructor() {
    this.devices = new Map();
    this.baselines = new Map();
    this.transferredDevices = new Set();
    this.hiddenDevices = new Set();
    this.events = [];
    this.dailyFacts = [];
    this.dailyFactDays = [];
    this.pricing = new Map();
    this.sessions = new Map();
    this.hubAccounts = new Map();
    this.hubCredentials = new Map();
    this.hubSnapshots = new Map();
    this.hubAudit = [];
    this.hubSessions = new Map();
  }

  async transaction(work) { return work(this); }

  async listDeviceRecords() {
    return [...this.devices.entries()]
      .filter(([deviceId]) => !this.hiddenDevices.has(deviceId))
      .map(([, record]) => clone(record));
  }

  async getDeviceRecord(deviceId) { return clone(this.devices.get(deviceId) || null); }

  async getActiveDeviceRecord(deviceId) {
    return this.hiddenDevices.has(deviceId) ? null : this.getDeviceRecord(deviceId);
  }

  // The in-memory store is single-threaded; keep the repository contract so
  // server tests exercise the same lock-before-baseline call sequence.
  async lockDevice(deviceId) { return this.devices.has(deviceId); }

  // Mirrors repository.lockAndLoadIngestState: one call that returns the lock,
  // the display snapshot, the raw baseline and whether the device is active.
  async lockAndLoadIngestState(deviceId) {
    const display = this.devices.get(deviceId) || null;
    const baseline = this.baselines.get(deviceId) || display;
    return {
      found: Boolean(display),
      display: clone(display),
      baseline: clone(baseline),
      transferred: this.transferredDevices.has(deviceId),
      active: Boolean(display) && !this.hiddenDevices.has(deviceId)
    };
  }

  async saveDevice(record, _executor, options = {}) {
    const stored = { ...record };
    delete stored.limits;
    delete stored.limitsOnly;
    this.devices.set(record.deviceId, clone(stored));
    this.hiddenDevices.delete(record.deviceId);
    if (options.baseline !== false) {
      const baseline = { ...(options.baseline === undefined ? stored : options.baseline) };
      delete baseline.limits;
      delete baseline.limitsOnly;
      this.baselines.set(record.deviceId, clone(baseline));
    }
  }

  async replaceUsageDailyFacts(deviceId, document) {
    const replaceAll = document.replaceAll === true || !Array.isArray(document.changedDays);
    const covered = new Set(this.dailyFactDays
      .filter((day) => day.deviceId === deviceId && day.source === document.source)
      .map((day) => day.date));
    const writeDates = replaceAll
      ? new Set(document.days.map((day) => day.date))
      : new Set([
        ...document.changedDays,
        ...document.days.map((day) => day.date).filter((date) => !covered.has(date))
      ]);
    const removeDates = replaceAll ? null : new Set([...writeDates, ...(document.removeDays || [])]);
    const retain = (row) => row.deviceId !== deviceId || row.source !== document.source
      || (removeDates && !removeDates.has(row.date));
    this.dailyFacts = this.dailyFacts.filter(retain);
    this.dailyFactDays = this.dailyFactDays.filter(retain);
    const facts = document.facts.filter((fact) => writeDates.has(fact.date));
    const days = document.days.filter((day) => writeDates.has(day.date));
    this.dailyFacts.push(...clone(facts));
    this.dailyFactDays.push(...clone(days));
    return { factCount: facts.length, dayCount: days.length, truncated: document.truncated === true };
  }

  async queryUsageDailyFacts({ from, to, filters = {}, limit = 50_000 }) {
    const matches = (row) => {
      if (this.hiddenDevices.has(row.deviceId)) return false;
      const date = String(row.date || row.day_key);
      if (date < from || date >= to || row.deviceId !== undefined && filters.device?.length && !filters.device.includes(row.deviceId)) return false;
      for (const name of ['client', 'model', 'provider']) {
        if (filters[name]?.length && !filters[name].includes(row[name])) return false;
      }
      return true;
    };
    const rows = this.dailyFacts.filter(matches).sort((left, right) => (
      left.date.localeCompare(right.date) || left.deviceId.localeCompare(right.deviceId)
      || left.client.localeCompare(right.client) || left.model.localeCompare(right.model)
      || left.provider.localeCompare(right.provider)
    )).slice(0, limit + 1).map((fact) => ({
      day_key: fact.date,
      device_id: fact.deviceId,
      client: fact.client,
      model: fact.model,
      provider: fact.provider,
      total_tokens: fact.tokens,
      output_tokens: fact.outputTokens,
      cache_read_tokens: fact.cacheReadTokens,
      cache_write_tokens: fact.cacheWriteTokens,
      unclassified_tokens: fact.unclassifiedTokens,
      cost_usd: fact.cost,
      message_count: fact.messages,
      token_components_available: fact.tokenComponentsAvailable,
      provenance: fact.provenance,
      source: fact.source,
      time_basis: fact.timeBasis
    }));
    const days = this.dailyFactDays.filter((day) => !this.hiddenDevices.has(day.deviceId) && day.date >= from && day.date < to
      && (!filters.device?.length || filters.device.includes(day.deviceId)))
      .slice(0, 10001).map((day) => ({ ...clone(day), day_key: day.date }));
    return { rows, days, truncated: this.dailyFacts.filter(matches).length > limit || days.length > 10000 };
  }

  async queryUsageEventAnalytics({ from, to, filters = {}, limit = 50_000 }) {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    const groups = new Map();
    for (const event of this.events) {
      const at = Date.parse(event.recordedAt);
      if (!(at >= fromMs && at < toMs) || this.hiddenDevices.has(event.deviceId)) continue;
      let excluded = false;
      for (const name of ['client', 'model']) {
        if (filters[name]?.length && !filters[name].includes(event[name])) excluded = true;
      }
      if (filters.device?.length && !filters.device.includes(event.deviceId)) excluded = true;
      if (filters.provider?.length && !filters.provider.includes(event.provider || '')) excluded = true;
      if (filters.project?.length && !filters.project.includes(event.projectId || '') && !filters.project.includes(event.projectLabel || '')) excluded = true;
      if (filters.session?.length && !filters.session.includes(event.sessionId)) excluded = true;
      if (excluded) continue;
      const hourStart = new Date(Math.floor(at / 3_600_000) * 3_600_000).toISOString();
      const key = JSON.stringify([hourStart, event.deviceId, event.client, event.sessionId, event.model,
        event.provider || '', event.projectId || '', event.projectLabel || '']);
      let group = groups.get(key);
      if (!group) {
        group = {
          hourStart, device_id: event.deviceId, client: event.client, session_id: event.sessionId,
          model: event.model, provider: event.provider || '', project_id: event.projectId || '',
          project_label: event.projectLabel || '', total_tokens: 0, input_tokens: 0,
          output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
          unclassified_tokens: 0, cost_usd: 0, message_count: 0, credits: 0
        };
        groups.set(key, group);
      }
      group.input_tokens += number(event.inputTokens);
      group.output_tokens += number(event.outputTokens);
      group.cache_read_tokens += number(event.cacheReadTokens);
      group.cache_write_tokens += number(event.cacheWriteTokens);
      // input_tokens is the uncached-input component, not an unclassified bucket.
      group.unclassified_tokens += 0;
      group.total_tokens += number(event.inputTokens) + number(event.outputTokens)
        + number(event.cacheReadTokens) + number(event.cacheWriteTokens);
      group.cost_usd += number(event.costUsd);
      group.message_count += number(event.messageCount);
      group.credits += number(event.credits);
    }
    const all = [...groups.values()].sort((left, right) => left.hourStart.localeCompare(right.hourStart)
      || String(left.device_id).localeCompare(String(right.device_id)) || left.client.localeCompare(right.client)
      || left.session_id.localeCompare(right.session_id) || left.model.localeCompare(right.model));
    return { rows: all.slice(0, limit + 1), truncated: all.length > limit };
  }

  async getIngestBaseline(deviceId) {
    const snapshot = this.baselines.get(deviceId) || this.devices.get(deviceId) || null;
    return { snapshot: clone(snapshot), transferred: this.transferredDevices.has(deviceId) };
  }

  async saveIngestBaseline(deviceId, snapshot, { transferred = undefined } = {}) {
    this.baselines.set(deviceId, clone(snapshot));
    // Tri-state, matching the MySQL repository: undefined keeps the flag.
    if (transferred === true) this.transferredDevices.add(deviceId);
    if (transferred === false) this.transferredDevices.delete(deviceId);
  }

  async moveDeviceUsageEvents(previousDeviceId, nextDeviceId) {
    for (const event of this.events) {
      if (event.deviceId === previousDeviceId) event.deviceId = nextDeviceId;
    }
  }

  async mergeDeviceSessions(fromDeviceId, toDeviceId) {
    const fromPrefix = `${fromDeviceId}\u0000`;
    for (const [key, value] of [...this.sessions.entries()]) {
      if (!key.startsWith(fromPrefix)) continue;
      const summary = clone(value);
      const targetKey = `${toDeviceId}\u0000${summary.client}\u0000${summary.sessionId}`;
      const existing = this.sessions.get(targetKey);
      if (existing) {
        for (const field of ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'messageCount', 'costUsd']) {
          existing[field] = (Number(existing[field]) || 0) + (Number(summary[field]) || 0);
        }
        existing.startedAt = [existing.startedAt, summary.startedAt].filter(Boolean).sort()[0] || existing.startedAt || summary.startedAt;
        existing.lastUsedAt = [existing.lastUsedAt, summary.lastUsedAt].filter(Boolean).sort().pop() || existing.lastUsedAt || summary.lastUsedAt;
        this.sessions.set(targetKey, existing);
      } else {
        this.sessions.set(targetKey, summary);
      }
      this.sessions.delete(key);
    }
  }

  async countDevices() { return this.devices.size - this.hiddenDevices.size; }

  async listHubAccounts() {
    return [...this.hubAccounts.values()]
      .map(clone)
      .sort((left, right) => `${left.provider}\u0000${left.name}\u0000${left.id}`.localeCompare(`${right.provider}\u0000${right.name}\u0000${right.id}`));
  }

  async getHubAccount(accountId) { return clone(this.hubAccounts.get(String(accountId || '')) || null); }

  async getHubAccountForUpdate(accountId) {
    return this.getHubAccount(accountId);
  }

  async listHubAccountSnapshots(accountIds) {
    const result = new Map();
    for (const id of accountIds || []) {
      const key = String(id || '');
      if (this.hubSnapshots.has(key)) result.set(key, clone(this.hubSnapshots.get(key)));
    }
    return result;
  }

  async findHubAccount(provider, accountKey = '', accountEmail = '') {
    const normalizedProvider = String(provider || '').trim();
    const normalizedKey = String(accountKey || '').trim();
    const normalizedEmail = String(accountEmail || '').trim().toLowerCase();
    if (!normalizedProvider || (!normalizedKey && !normalizedEmail)) return null;
    for (const account of this.hubAccounts.values()) {
      if (account.provider !== normalizedProvider) continue;
      if (normalizedKey && account.accountKey === normalizedKey) return clone(account);
      if (normalizedEmail && String(account.accountEmail || '').toLowerCase() === normalizedEmail) return clone(account);
    }
    return null;
  }

  async createHubAccount(account, envelope, snapshot) {
    const id = String(account.id || '');
    this.hubAccounts.set(id, clone(account));
    this.hubCredentials.set(id, clone(envelope));
    this.hubSnapshots.set(id, clone(snapshot));
    return this.getHubAccount(id);
  }

  async updateHubAccount(accountId, patch = {}) {
    const id = String(accountId || '');
    const current = this.hubAccounts.get(id);
    if (!current) return null;
    this.hubAccounts.set(id, { ...current, ...clone(patch) });
    return this.getHubAccount(id);
  }

  async deleteHubAccount(accountId) {
    const id = String(accountId || '');
    const deleted = this.hubAccounts.delete(id);
    this.hubCredentials.delete(id);
    this.hubSnapshots.delete(id);
    return deleted;
  }

  async getHubAccountCredential(accountId) {
    return clone(this.hubCredentials.get(String(accountId || '')) || null);
  }

  async replaceHubAccountCredential(accountId, envelope) {
    const id = String(accountId || '');
    this.hubCredentials.set(id, clone(envelope));
    return this.getHubAccountCredential(id);
  }

  async getHubAccountSnapshot(accountId) {
    return clone(this.hubSnapshots.get(String(accountId || '')) || null);
  }

  async saveHubAccountSnapshot(accountId, snapshot) {
    const id = String(accountId || '');
    this.hubSnapshots.set(id, clone(snapshot));
    return this.getHubAccountSnapshot(id);
  }

  async appendHubAccountAudit(accountId, action, actor = '', details = null) {
    this.hubAudit.push({
      id: this.hubAudit.length + 1,
      accountId: accountId ? String(accountId) : null,
      action: String(action || ''),
      actor: String(actor || ''),
      details: clone(details),
      createdAt: new Date().toISOString()
    });
  }

  async listHubSessions() {
    return [...this.hubSessions.values()]
      .map(clone)
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)));
  }

  async loadActiveHubSessions() {
    const now = Date.now();
    return [...this.hubSessions.values()]
      .filter((session) => !session.revokedAt && (!session.expiresAt || Date.parse(session.expiresAt) > now))
      .map(clone);
  }

  async createHubSession(session) {
    this.hubSessions.set(session.sessionId, clone(session));
    return clone(session);
  }

  async touchHubSession(sessionId, patch = {}) {
    const current = this.hubSessions.get(String(sessionId || ''));
    if (!current || current.revokedAt) return false;
    this.hubSessions.set(current.sessionId, {
      ...current,
      ...(patch.lastSeenAt !== undefined ? { lastSeenAt: patch.lastSeenAt } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {})
    });
    return true;
  }

  async revokeHubSession(sessionId) {
    const current = this.hubSessions.get(String(sessionId || ''));
    if (!current || current.revokedAt) return false;
    current.revokedAt = new Date().toISOString();
    return true;
  }

  async revokeAllHubSessions() {
    let count = 0;
    const at = new Date().toISOString();
    for (const session of this.hubSessions.values()) {
      if (session.revokedAt) continue;
      session.revokedAt = at;
      count += 1;
    }
    return count;
  }

  async getPricing(models) {
    return new Map(models.filter(Boolean).map((model) => [model, clone(this.pricing.get(model))]).filter(([, item]) => item));
  }

  async listPricing() { return [...this.pricing.values()].map(clone).sort((a, b) => a.model.localeCompare(b.model)); }

  async upsertPricing(model, prices, source) {
    const item = {
      id: this.pricing.get(model)?.id || this.pricing.size + 1,
      model,
      ...prices,
      source,
      updatedAt: new Date().toISOString()
    };
    this.pricing.set(model, item);
    return clone(item);
  }

  async insertUsageEvents(deviceId, events) {
    for (const event of events) this.events.push({ id: this.events.length + 1, deviceId, ...clone(event) });
  }

  async replaceSessions(deviceId, summaries, _executor, { previousSummaries } = {}) {
    const previous = previousSummaries === undefined
      ? [...this.sessions.entries()].filter(([key]) => key.startsWith(`${deviceId}\u0000`)).map(([, value]) => value)
      : previousSummaries;
    const nextKeys = new Set(summaries.map((summary) => `${deviceId}\u0000${summary.client}\u0000${summary.sessionId}`));
    for (const summary of previous) {
      const key = `${deviceId}\u0000${summary.client}\u0000${summary.sessionId}`;
      if (!nextKeys.has(key)) this.sessions.delete(key);
    }
    for (const summary of summaries) this.sessions.set(`${deviceId}\u0000${summary.client}\u0000${summary.sessionId}`, clone(summary));
  }

  async deleteDevice(deviceId) {
    const deleted = this.devices.has(deviceId) && !this.hiddenDevices.has(deviceId);
    if (deleted) this.hiddenDevices.add(deviceId);
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`${deviceId}\u0000`)) this.sessions.delete(key);
    return deleted;
  }

  async renameDevice(previousDeviceId, nextDeviceId) {
    if (previousDeviceId === nextDeviceId && this.devices.has(previousDeviceId)) {
      return { renamed: true, deviceId: nextDeviceId, unchanged: true };
    }
    if (!this.devices.has(previousDeviceId)) return { renamed: false, reason: 'not_found' };
    if (this.devices.has(nextDeviceId)) return { renamed: false, reason: 'target_exists' };
    const record = this.devices.get(previousDeviceId);
    this.devices.set(nextDeviceId, { ...clone(record), deviceId: nextDeviceId });
    this.devices.delete(previousDeviceId);
    if (this.baselines.has(previousDeviceId)) {
      this.baselines.set(nextDeviceId, { ...clone(this.baselines.get(previousDeviceId)), deviceId: nextDeviceId });
      this.baselines.delete(previousDeviceId);
    }
    if (this.transferredDevices.delete(previousDeviceId)) this.transferredDevices.add(nextDeviceId);
    if (this.hiddenDevices.delete(previousDeviceId)) this.hiddenDevices.add(nextDeviceId);
    for (const event of this.events) if (event.deviceId === previousDeviceId) event.deviceId = nextDeviceId;
    const moved = [];
    for (const [key, value] of this.sessions) {
      if (!key.startsWith(`${previousDeviceId}\u0000`)) continue;
      moved.push([`${nextDeviceId}${key.slice(previousDeviceId.length)}`, value]);
      this.sessions.delete(key);
    }
    for (const [key, value] of moved) this.sessions.set(key, value);
    return { renamed: true, deviceId: nextDeviceId, previousDeviceId };
  }

  async listKnownModels() {
    return [...new Set(this.events.map((event) => event.model).filter((model) => model && model !== 'unknown'))].sort();
  }

  async aggregateUsageRange({ from, to }) {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    const result = emptyUsageRange();
    if (!(fromMs < toMs)) return result;
    for (const event of this.events) {
      const at = new Date(event.recordedAt).getTime();
      if (!(at >= fromMs && at < toMs)) continue;
      result.eventCount += 1;
      const tokens = Math.round(
        number(event.inputTokens)
        + number(event.outputTokens)
        + number(event.cacheReadTokens)
        + number(event.cacheWriteTokens)
      );
      const cost = number(event.costUsd);
      const client = String(event.client || 'unknown');
      const model = String(event.model || 'unknown');
      result.totalTokens += tokens;
      result.costUsd += cost;
      addTokenCost(result.clients, result.clientCosts, client, tokens, cost);
      addTokenCost(result.models, result.modelCosts, model, tokens, cost);
      if (!result.clientModels[client]) result.clientModels[client] = {};
      if (!result.clientModelCosts[client]) result.clientModelCosts[client] = {};
      result.clientModels[client][model] = (result.clientModels[client][model] || 0) + tokens;
      result.clientModelCosts[client][model] = (result.clientModelCosts[client][model] || 0) + cost;
      // Sparse, mirroring the real query: a client with no credit meter is absent
      // from the map rather than reported as a zero.
      const credits = number(event.credits);
      if (credits > 0) result.clientCredits[client] = (result.clientCredits[client] || 0) + credits;
    }
    return result;
  }
}

module.exports = { MemoryRepository };
