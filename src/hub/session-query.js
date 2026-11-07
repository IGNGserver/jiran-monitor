'use strict';

const crypto = require('node:crypto');

const SORTS = new Set(['lastUsedAt', 'totalTokens', 'costUsd', 'client', 'messageCount']);

function badQuery(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 400;
  return error;
}

function normalizedSessions(stats, period) {
  const rows = [];
  for (const device of Array.isArray(stats?.devices) ? stats.devices : []) {
    const deviceId = String(device?.deviceId || device?.id || '');
    const sessions = device?.periods?.[period]?.sessions || {};
    for (const [fallbackKey, session] of Object.entries(sessions)) {
      if (!session || Number(session.totalTokens || 0) <= 0) continue;
      const client = String(session.client || 'unknown');
      const sessionId = String(session.sessionId || fallbackKey || '');
      rows.push({
        ...session,
        key: `${deviceId}:${client}:${sessionId}`,
        deviceId,
        hostname: String(device?.hostname || deviceId),
        client,
        sessionId
      });
    }
  }
  return rows;
}

function querySignature(query) {
  return crypto.createHash('sha256').update(JSON.stringify({
    period: query.period, filters: query.filters, sort: query.sort, order: query.order
  })).digest('hex').slice(0, 16);
}

function cursorOffset(searchParams, signature) {
  const raw = String(searchParams.get('cursor') || '');
  if (!raw) return 0;
  try {
    const cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (cursor.v !== 1 || cursor.q !== signature || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('invalid');
    return cursor.offset;
  } catch (_) {
    throw badQuery('invalid_cursor');
  }
}

function querySessions(stats, searchParams) {
  const period = String(searchParams.get('period') || 'allTime');
  if (!['today', 'month', 'allTime'].includes(period)) throw badQuery('invalid_period');
  const sort = String(searchParams.get('sort') || 'lastUsedAt');
  if (!SORTS.has(sort)) throw badQuery('invalid_sort');
  const order = String(searchParams.get('order') || 'desc');
  if (!['asc', 'desc'].includes(order)) throw badQuery('invalid_order');
  const rawLimit = String(searchParams.get('limit') || '200');
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw badQuery('invalid_limit');
  const q = String(searchParams.get('q') || '').trim();
  if (q.length > 256) throw badQuery('invalid_q');
  const filters = {
    deviceId: String(searchParams.get('deviceId') || '').trim(),
    client: String(searchParams.get('client') || '').trim(),
    model: String(searchParams.get('model') || '').trim(),
    project: String(searchParams.get('project') || '').trim(),
    q
  };
  for (const [key, value] of Object.entries(filters)) {
    if (value.length > 255) throw badQuery(`invalid_${key}`);
  }
  const needle = q.toLocaleLowerCase();
  const filtered = normalizedSessions(stats, period).filter((row) => {
    if (filters.deviceId && row.deviceId !== filters.deviceId) return false;
    if (filters.client && row.client !== filters.client) return false;
    if (filters.model && !Object.prototype.hasOwnProperty.call(row.models || {}, filters.model)) return false;
    if (filters.project && ![row.projectId, row.projectLabel, row.projectKey, `${row.deviceId}:${row.projectId}`].includes(filters.project)) return false;
    if (needle && ![
      row.client, row.sessionId, row.deviceId, row.hostname, row.projectId, row.projectLabel,
      ...Object.keys(row.models || {})
    ].some((value) => String(value || '').toLocaleLowerCase().includes(needle))) return false;
    return true;
  });
  const direction = order === 'asc' ? 1 : -1;
  filtered.sort((left, right) => {
    let comparison;
    if (sort === 'client') comparison = left.client.localeCompare(right.client);
    else if (sort === 'lastUsedAt') {
      comparison = Date.parse(left.lastUsedAt || left.startedAt || 0) - Date.parse(right.lastUsedAt || right.startedAt || 0);
    } else comparison = Number(left[sort] || 0) - Number(right[sort] || 0);
    if (comparison) return comparison * direction;
    return left.key.localeCompare(right.key);
  });
  const signature = querySignature({ period, filters, sort, order });
  const offset = cursorOffset(searchParams, signature);
  const sessions = filtered.slice(offset, offset + limit);
  const nextOffset = offset + sessions.length;
  return {
    sessions,
    total: filtered.length,
    limit,
    nextCursor: nextOffset < filtered.length && sessions.length
      ? Buffer.from(JSON.stringify({ v: 1, q: signature, offset: nextOffset })).toString('base64url')
      : null,
    period,
    sort,
    order,
    filters
  };
}

module.exports = { querySessions };
