'use strict';

const crypto = require('node:crypto');
const { dayKeyAddDays } = require('../shared/history');
const { dayKeyOf, normalizeTimeZone, startOfDayMs } = require('../shared/fleetTimeZone');

const DIMENSIONS = new Set(['date', 'device', 'client', 'model', 'provider', 'project', 'session']);
const FILTER_DIMENSIONS = ['device', 'client', 'model', 'project', 'provider', 'session'];
const METRIC_ALIASES = Object.freeze({
  tokens: 'totalTokens', totalTokens: 'totalTokens',
  cost: 'costUsd', costUsd: 'costUsd',
  messages: 'messageCount', messageCount: 'messageCount',
  output: 'outputTokens', outputTokens: 'outputTokens',
  cacheRead: 'cacheReadTokens', cacheReadTokens: 'cacheReadTokens',
  cacheWrite: 'cacheWriteTokens', cacheWriteTokens: 'cacheWriteTokens',
  unclassified: 'unclassifiedTokens', unclassifiedTokens: 'unclassifiedTokens',
  credits: 'credits'
});
const COMPONENT_METRICS = new Set(['outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unclassifiedTokens']);
const DEFAULT_METRICS = Object.freeze([
  'totalTokens', 'costUsd', 'messageCount', 'outputTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'unclassifiedTokens'
]);
const SOURCE_ROW_LIMIT = 50_000;
const RESPONSE_ROW_LIMIT = 5_000;
const SERIES_POINT_LIMIT = 5_000;
const MAX_RANGE_DAYS = 370;

function badQuery(code, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validDay(value) {
  const day = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? '' : day;
}

function list(searchParams, name) {
  const values = [];
  const seen = new Set();
  for (const part of searchParams.getAll(name).flatMap((value) => String(value).split(','))) {
    const value = part.trim();
    if (!value) continue;
    if (value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) throw badQuery(`invalid_${name}`);
    if (!seen.has(value)) {
      if (seen.size >= 100) throw badQuery(`too_many_${name}_filters`);
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

function enumList(searchParams, name, allowed) {
  const values = list(searchParams, name);
  for (const value of values) if (!allowed.has(value)) throw badQuery(`invalid_${name}`);
  return values;
}

function positiveInteger(searchParams, name, fallback, maximum) {
  const raw = searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw badQuery(`invalid_${name}`);
  return value;
}

function dayRange(startDate, endDate) {
  const days = [];
  for (let day = startDate; day <= endDate; day = dayKeyAddDays(day, 1)) {
    days.push(day);
    if (days.length > MAX_RANGE_DAYS) throw badQuery('range_too_large', `range is limited to ${MAX_RANGE_DAYS} days`);
  }
  return days;
}

function normalizeAnalyticsQuery(searchParams, options = {}) {
  const explicitZone = searchParams.get('timeZone') || searchParams.get('timezone') || '';
  if (explicitZone && !normalizeTimeZone(explicitZone)) throw badQuery('invalid_timeZone');
  const timeZone = normalizeTimeZone(explicitZone || options.fleetTimeZone || '') || 'UTC';
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  let startDate = validDay(searchParams.get('startDate') || searchParams.get('from') || '');
  let endDate = validDay(searchParams.get('endDate') || searchParams.get('to') || '');
  const fromInstant = Date.parse(searchParams.get('from') || '');
  const toInstant = Date.parse(searchParams.get('to') || '');
  if (!startDate && Number.isFinite(fromInstant)) startDate = dayKeyOf(new Date(fromInstant), timeZone);
  if (!endDate && Number.isFinite(toInstant)) endDate = dayKeyOf(new Date(toInstant), timeZone);
  endDate ||= dayKeyOf(now, timeZone);
  startDate ||= dayKeyAddDays(endDate, -29);
  if (!validDay(startDate) || !validDay(endDate)) throw badQuery('invalid_date_range');
  if (startDate > endDate) throw badQuery('invalid_date_range');
  const days = dayRange(startDate, endDate);
  const bucket = searchParams.get('bucket') || 'day';
  if (!['day', 'hour', 'none'].includes(bucket)) throw badQuery('invalid_bucket');
  const groupBy = enumList(searchParams, 'groupBy', DIMENSIONS);
  if (groupBy.length > 5) throw badQuery('too_many_groupBy');
  const requestedMetrics = list(searchParams, 'metrics');
  const metrics = requestedMetrics.length
    ? requestedMetrics.map((metric) => {
      const normalized = METRIC_ALIASES[metric];
      if (!normalized) throw badQuery('invalid_metrics');
      return normalized;
    })
    : [...DEFAULT_METRICS];
  const uniqueMetrics = [...new Set(metrics)];
  const filters = {};
  for (const name of FILTER_DIMENSIONS) filters[name] = list(searchParams, name);
  const requestedSort = searchParams.get('sort') || (uniqueMetrics.includes('totalTokens') ? 'totalTokens' : uniqueMetrics[0]);
  const sort = METRIC_ALIASES[requestedSort] || requestedSort;
  if (![...DIMENSIONS, 'bucket', ...Object.values(METRIC_ALIASES)].includes(sort)) throw badQuery('invalid_sort');
  const order = searchParams.get('order') || (searchParams.get('direction') || 'desc');
  if (!['asc', 'desc'].includes(order)) throw badQuery('invalid_order');
  const source = searchParams.get('source') || 'auto';
  if (!['auto', 'history', 'events'].includes(source)) throw badQuery('invalid_source');
  const format = searchParams.get('format') || 'json';
  if (!['json', 'csv'].includes(format)) throw badQuery('invalid_format');
  return {
    startDate,
    endDate,
    days,
    timeZone,
    explicitTimeZone: Boolean(explicitZone || options.fleetTimeZone),
    bucket,
    groupBy,
    metrics: uniqueMetrics,
    filters,
    sort,
    order,
    source,
    format,
    top: positiveInteger(searchParams, 'top', 20, 100),
    limit: positiveInteger(searchParams, 'limit', 200, RESPONSE_ROW_LIMIT),
    cursor: String(searchParams.get('cursor') || ''),
    sourceRowLimit: Math.max(1, Math.min(SOURCE_ROW_LIMIT, options.sourceRowLimit || SOURCE_ROW_LIMIT))
  };
}

function startForDay(day, timeZone) {
  return startOfDayMs(new Date(`${day}T12:00:00.000Z`), timeZone);
}

function eventWindow(query) {
  return {
    from: new Date(startForDay(query.startDate, query.timeZone)),
    to: new Date(startForDay(dayKeyAddDays(query.endDate, 1), query.timeZone))
  };
}

function safeKey(value) {
  const key = String(value ?? '').trim();
  return key && !['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase()) ? key : 'unknown';
}

function dimensionValue(row, dimension) {
  if (dimension === 'date') return row.date || '';
  if (dimension === 'device') return row.deviceId || 'unknown';
  if (dimension === 'project') return row.projectId || row.projectLabel || '';
  if (dimension === 'session') return row.sessionId || '';
  return safeKey(row[dimension]);
}

function bucketValue(row, bucket, timeZone) {
  if (bucket === 'none') return '';
  if (row.source === 'tokscaleGraph' || (!row.hourStart && row.date)) return row.date;
  const instant = new Date(row.hourStart);
  if (bucket === 'hour') {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:00`;
  }
  return dayKeyOf(instant, timeZone);
}

function newAggregate() {
  return Object.fromEntries(Object.values(METRIC_ALIASES).map((metric) => [metric, 0]));
}

function aggregateInto(target, row) {
  target.totalTokens += finite(row.tokens ?? row.totalTokens);
  const cost = row.cost ?? row.costUsd;
  if (cost === null || cost === undefined) target.costUsd = null;
  else if (target.costUsd !== null) target.costUsd += finite(cost);
  target.messageCount += finite(row.messages ?? row.messageCount);
  target.credits += finite(row.credits);
  for (const metric of COMPONENT_METRICS) {
    const value = row[metric];
    if (value === null || value === undefined) target[metric] = null;
    else if (target[metric] !== null) target[metric] += finite(value);
  }
}

function rowIdentity(row) {
  return JSON.stringify([row.bucket || '', ...Object.keys(row).filter((key) => !Object.hasOwn(METRIC_ALIASES, key) && key !== 'bucket' && !['provenance', 'estimated', 'allocated', 'componentCoverage', 'timeBasis'].includes(key)).sort().map((key) => [key, row[key]])]);
}

function compareValues(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function compareRows(left, right, sort, order) {
  const direction = order === 'asc' ? 1 : -1;
  const primary = compareValues(left[sort], right[sort]);
  if (primary) return primary * direction;
  return rowIdentity(left).localeCompare(rowIdentity(right));
}

function cursorSignature(query) {
  return crypto.createHash('sha256').update(JSON.stringify({
    startDate: query.startDate, endDate: query.endDate, timeZone: query.timeZone,
    bucket: query.bucket, groupBy: query.groupBy, metrics: query.metrics,
    filters: query.filters, sort: query.sort, order: query.order, source: query.source
  })).digest('hex').slice(0, 16);
}

function encodeCursor(query, row) {
  return Buffer.from(JSON.stringify({
    v: 1, q: cursorSignature(query), value: row[query.sort] ?? null, identity: rowIdentity(row)
  })).toString('base64url');
}

function cursorPosition(query, rows) {
  if (!query.cursor) return 0;
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
  } catch (_) {
    throw badQuery('invalid_cursor');
  }
  if (cursor.v !== 1 || cursor.q !== cursorSignature(query) || typeof cursor.identity !== 'string') throw badQuery('invalid_cursor');
  const index = rows.findIndex((row) => rowIdentity(row) === cursor.identity
    && compareValues(row[query.sort] ?? null, cursor.value ?? null) === 0);
  if (index < 0) throw badQuery('stale_cursor', 'cursor no longer identifies a row in the ordered result');
  return index + 1;
}

function selectedDimensions(query) {
  const dimensions = [...query.groupBy];
  if (query.bucket === 'day' && !dimensions.includes('date')) dimensions.unshift('date');
  return dimensions;
}

function projectAggregate(keyParts, aggregate, query) {
  const row = {};
  const dimensions = selectedDimensions(query);
  dimensions.forEach((dimension, index) => { row[dimension] = keyParts[index]; });
  if (query.bucket === 'hour') row.hour = keyParts[0];
  if (query.bucket !== 'none') row.bucket = keyParts[0];
  for (const metric of query.metrics) row[metric] = aggregate[metric];
  return row;
}

function aggregateSourceRows(sourceRows, query) {
  const groups = new Map();
  const dimensions = selectedDimensions(query);
  for (const sourceRow of sourceRows) {
    const bucket = bucketValue(sourceRow, query.bucket, query.timeZone);
    const keyParts = query.bucket === 'hour'
      ? [bucket, ...dimensions.map((dimension) => dimensionValue(sourceRow, dimension))]
      : query.bucket === 'day'
        ? [bucket, ...dimensions.filter((dimension) => dimension !== 'date').map((dimension) => dimensionValue(sourceRow, dimension))]
        : dimensions.map((dimension) => dimensionValue(sourceRow, dimension));
    // projectAggregate expects one date/bucket key followed by the remaining
    // declared dimensions. Normalize the layout once here.
    const normalizedParts = query.bucket === 'hour'
      ? keyParts
      : query.bucket === 'day'
        ? [bucket, ...dimensions.filter((dimension) => dimension !== 'date').map((dimension) => dimensionValue(sourceRow, dimension))]
        : keyParts;
    const key = JSON.stringify(normalizedParts);
    let aggregate = groups.get(key);
    if (!aggregate) {
      aggregate = { values: newAggregate(), keyParts: normalizedParts, provenance: new Set(), timeBasis: new Set(), componentUnavailable: false };
      groups.set(key, aggregate);
    }
    aggregateInto(aggregate.values, sourceRow);
    if (sourceRow.provenance) aggregate.provenance.add(sourceRow.provenance);
    if (sourceRow.timeBasis) aggregate.timeBasis.add(sourceRow.timeBasis);
    if ([...COMPONENT_METRICS].some((metric) => sourceRow[metric] === null || sourceRow[metric] === undefined)) aggregate.componentUnavailable = true;
  }
  return [...groups.values()].map((group) => {
    let row;
    if (query.bucket === 'hour') {
      row = {};
      query.groupBy.forEach((dimension, index) => { row[dimension] = group.keyParts[index + 1]; });
      row.hour = group.keyParts[0];
      row.bucket = group.keyParts[0];
      for (const metric of query.metrics) row[metric] = group.values[metric];
    } else if (query.bucket === 'day') {
      row = { date: group.keyParts[0], bucket: group.keyParts[0] };
      query.groupBy.filter((dimension) => dimension !== 'date').forEach((dimension, index) => {
        row[dimension] = group.keyParts[index + 1];
      });
      for (const metric of query.metrics) row[metric] = group.values[metric];
    } else {
      row = projectAggregate(group.keyParts, group.values, query);
    }
    row.provenance = group.provenance.size === 1 ? [...group.provenance][0] : 'mixed';
    row.timeBasis = group.timeBasis.size === 1 ? [...group.timeBasis][0] : 'mixed';
    row.componentCoverage = group.componentUnavailable ? 'partial' : 'complete';
    return row;
  });
}

function addRows(left, right) {
  const output = { ...left };
  for (const metric of Object.values(METRIC_ALIASES)) {
    if (!Object.hasOwn(left, metric) && !Object.hasOwn(right, metric)) continue;
    output[metric] = left[metric] === null || right[metric] === null
      ? null
      : finite(left[metric]) + finite(right[metric]);
  }
  return output;
}

function topBreakdown(rows, query) {
  const dimensionalRows = rows.map((row) => {
    const copy = { ...row };
    delete copy.bucket;
    if (query.bucket !== 'none') {
      delete copy.date;
      delete copy.hour;
    }
    return copy;
  });
  const groups = new Map();
  for (const row of dimensionalRows) {
    const key = rowIdentity(row);
    const previous = groups.get(key);
    if (previous) {
      const combined = addRows(previous, row);
      combined.provenance = previous.provenance === row.provenance ? previous.provenance : 'mixed';
      combined.timeBasis = previous.timeBasis === row.timeBasis ? previous.timeBasis : 'mixed';
      combined.componentCoverage = previous.componentCoverage === 'complete' && row.componentCoverage === 'complete' ? 'complete' : 'partial';
      groups.set(key, combined);
    } else groups.set(key, row);
  }
  const sorted = [...groups.values()].sort((left, right) => compareRows(left, right, query.sort === 'bucket' || query.sort === 'date' ? 'totalTokens' : query.sort, query.order));
  const retained = sorted.slice(0, query.top);
  const rest = sorted.slice(query.top);
  if (rest.length) {
    const other = rest.reduce((sum, row) => addRows(sum, row), {});
    for (const dimension of query.groupBy) other[dimension] = 'Other';
    const provenance = [...new Set(rest.map((row) => row.provenance).filter(Boolean))];
    const timeBasis = [...new Set(rest.map((row) => row.timeBasis).filter(Boolean))];
    other.provenance = provenance.length === 1 ? provenance[0] : 'mixed';
    other.timeBasis = timeBasis.length === 1 ? timeBasis[0] : 'mixed';
    other.componentCoverage = rest.some((row) => row.componentCoverage === 'partial') ? 'partial' : 'complete';
    retained.push(other);
  }
  return { rows: retained, otherCount: rest.length, truncated: rest.length > 0 };
}

function metricDescriptions(query, source, componentUnavailable, costUnavailable) {
  const bestEffort = source === 'usageEventsBestEffort';
  const mixed = source === 'mixed';
  return Object.fromEntries(query.metrics.map((metric) => [metric, {
    estimated: bestEffort,
    allocated: bestEffort && metric !== 'totalTokens',
    mixed,
    available: COMPONENT_METRICS.has(metric) ? !componentUnavailable : metric === 'costUsd' ? !costUnavailable : true,
    unit: metric === 'costUsd' ? 'USD' : metric === 'credits' ? 'credits' : metric === 'messageCount' ? 'messages' : 'tokens',
    description: metric === 'messageCount'
      ? 'Message/activity count (or session deltas for event source); never an API request count.'
      : mixed
        ? 'Mixed exact graph and best-effort event rows; inspect each row provenance.'
        : bestEffort
          ? 'Best-effort usage_events attribution; recordedAt/lastUsedAt buckets are not exact request times.'
          : 'Daily tokscale graph fact; no cross-source allocation.'
  }]));
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  // Spreadsheet formulas can begin after whitespace/control characters too.
  if (/^(?:\s*[=+\-@]|[\t\r])/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function analyticsCsv(result) {
  const rowColumns = [...new Set(result.rows.flatMap((row) => Object.keys(row).filter((key) => !['provenance', 'componentCoverage'].includes(key))))];
  const metadata = ['source', 'timeBasis', 'timeZone', 'revision', 'bestEffort', 'truncated'];
  const headers = [...rowColumns, ...metadata.map((key) => `_${key}`)];
  const lines = [headers.map(csvCell).join(',')];
  for (const row of result.rows) {
    lines.push(headers.map((header) => {
      if (header === '_source') return csvCell(result.source);
      if (header === '_timeBasis') return csvCell(result.timeBasis);
      if (header === '_timeZone') return csvCell(result.timeZone);
      if (header === '_revision') return csvCell(result.revision);
      if (header === '_bestEffort') return csvCell(result.bestEffort === true);
      if (header === '_truncated') return csvCell(result.truncated);
      return csvCell(row[header]);
    }).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function createUsageAnalyticsService({ store, fleetTimeZone = '', now = () => new Date(), sourceRowLimit = SOURCE_ROW_LIMIT }) {
  async function query(searchParams) {
    if (typeof store.queryUsageDailyFacts !== 'function' || typeof store.queryUsageEventAnalytics !== 'function') {
      const error = new Error('usage analytics repository capability unavailable');
      error.code = 'analytics_unavailable';
      error.status = 503;
      throw error;
    }
    const normalized = normalizeAnalyticsQuery(searchParams, { fleetTimeZone, now: now(), sourceRowLimit });
    const eventOnly = normalized.bucket === 'hour' || normalized.metrics.includes('credits')
      || normalized.filters.project.length > 0 || normalized.filters.session.length > 0
      || normalized.groupBy.some((dimension) => ['project', 'session'].includes(dimension))
      || (normalized.explicitTimeZone && (!fleetTimeZone || normalized.timeZone !== fleetTimeZone));
    let source = normalized.source === 'events' || (normalized.source === 'auto' && eventOnly)
      ? 'usageEventsBestEffort'
      : 'tokscaleGraph';
    if (normalized.source === 'history' && eventOnly) throw badQuery('history_source_cannot_answer', 'hour/project/session/credits/rebased-time-zone queries require source=events');
    let raw;
    let eventRaw;
    let sourceRows;
    let coverageDays = [];
    let rowTruncated;
    const toDailyRow = (row, bestEffort = false) => ({
      date: String(row.day_key || row.date), deviceId: row.device_id ?? row.deviceId,
      client: row.client, model: row.model, provider: row.provider,
      tokens: finite(row.total_tokens ?? row.tokens),
      cost: row.cost_usd ?? row.cost ?? null,
      messages: finite(row.message_count ?? row.messages),
      outputTokens: row.output_tokens ?? row.outputTokens,
      cacheReadTokens: row.cache_read_tokens ?? row.cacheReadTokens,
      cacheWriteTokens: row.cache_write_tokens ?? row.cacheWriteTokens,
      unclassifiedTokens: row.unclassified_tokens ?? row.unclassifiedTokens,
      provenance: bestEffort ? 'bestEffort' : row.provenance,
      timeBasis: bestEffort ? 'recordedAtDay' : 'producerCalendarDay',
      source: bestEffort ? 'usageEventsBestEffort' : 'tokscaleGraph'
    });
    const toEventRow = (row) => {
      const hourStart = row.hour_bucket ? new Date(`${String(row.hour_bucket).replace(' ', 'T')}Z`).toISOString() : row.hourStart;
      return {
        hourStart,
        date: row.date || (hourStart ? dayKeyOf(new Date(hourStart), normalized.timeZone) : ''),
        deviceId: row.device_id ?? row.deviceId,
        client: row.client, model: row.model, provider: row.provider || '',
        sessionId: row.session_id ?? row.sessionId,
        projectId: row.project_id ?? row.projectId,
        projectLabel: row.project_label ?? row.projectLabel,
        tokens: finite(row.total_tokens ?? row.tokens),
      cost: row.cost_usd ?? row.cost ?? null,
        messages: finite(row.message_count ?? row.messages),
        outputTokens: finite(row.output_tokens ?? row.outputTokens),
        cacheReadTokens: finite(row.cache_read_tokens ?? row.cacheReadTokens),
        cacheWriteTokens: finite(row.cache_write_tokens ?? row.cacheWriteTokens),
        unclassifiedTokens: finite(row.unclassified_tokens ?? row.unclassifiedTokens),
        credits: finite(row.credits), provenance: 'bestEffort',
        timeBasis: normalized.bucket === 'hour' ? 'recordedAt' : 'recordedAtDay', source: 'usageEventsBestEffort'
      };
    };
    if (source === 'tokscaleGraph') {
      raw = await store.queryUsageDailyFacts({
        from: normalized.startDate, to: dayKeyAddDays(normalized.endDate, 1), filters: normalized.filters,
        limit: normalized.sourceRowLimit
      });
      const graphRows = raw.rows.filter((row) => row.source === 'tokscaleGraph');
      const bestRows = raw.rows.filter((row) => row.source === 'usageEventsBestEffort');
      const graphCoverage = raw.days.filter((day) => day.source === 'tokscaleGraph');
      const bestCoverage = raw.days.filter((day) => day.source === 'usageEventsBestEffort');
      const partition = (row) => `${row.deviceId ?? row.device_id}\u0000${row.day_key || row.date}`;
      const graphPartitions = new Set([...graphCoverage, ...graphRows].map(partition));
      const fallbackRows = bestRows.filter((row) => !graphPartitions.has(partition(row)));
      coverageDays = [...graphCoverage, ...bestCoverage.filter((day) => !graphPartitions.has(partition(day)))];
      rowTruncated = raw.truncated || raw.rows.length > normalized.sourceRowLimit;
      if (normalized.source === 'history') {
        sourceRows = graphRows.map((row) => toDailyRow(row));
      } else {
        // A migration may not have materialized every event-derived partition.
        // Query the bounded ledger too, but never let it overlap an exact graph
        // partition or an already-materialized best-effort partition.
        eventRaw = await store.queryUsageEventAnalytics({
          ...eventWindow(normalized), filters: normalized.filters, limit: normalized.sourceRowLimit
        });
        const eventRows = eventRaw.rows.map(toEventRow);
        const eventCoveredBy = (coverage, dailyRows, defaultZone) => {
          const devices = new Map();
          const add = (row) => {
            const deviceId = String(row.deviceId ?? row.device_id ?? '');
            const date = String(row.day_key || row.date || '');
            const zone = normalizeTimeZone(row.time_zone || row.timeZone || '') || defaultZone;
            if (!deviceId || !date) return;
            const zones = devices.get(deviceId) || new Map();
            const dates = zones.get(zone) || new Set();
            dates.add(date);
            zones.set(zone, dates);
            devices.set(deviceId, zones);
          };
          coverage.forEach(add);
          dailyRows.forEach(add);
          return (row) => {
            const instant = new Date(row.hourStart);
            if (Number.isNaN(instant.getTime())) return false;
            for (const [zone, dates] of devices.get(String(row.deviceId)) || []) {
              if (dates.has(dayKeyOf(instant, zone))) return true;
            }
            return false;
          };
        };
        const graphCoversEvent = eventCoveredBy(graphCoverage, graphRows, normalized.timeZone);
        const bestCoversEvent = eventCoveredBy(bestCoverage, bestRows, 'UTC');
        const uncoveredEventRows = eventRows.filter((row) => !graphCoversEvent(row) && !bestCoversEvent(row));
        sourceRows = [
          ...graphRows.map((row) => toDailyRow(row)),
          ...fallbackRows.map((row) => toDailyRow(row, true)),
          ...uncoveredEventRows
        ];
        rowTruncated ||= eventRaw.truncated || eventRaw.rows.length > normalized.sourceRowLimit;
        const hasGraphRows = sourceRows.some((row) => row.source === 'tokscaleGraph');
        const hasBestRows = sourceRows.some((row) => row.source === 'usageEventsBestEffort');
        source = hasGraphRows && hasBestRows ? 'mixed' : hasGraphRows ? 'tokscaleGraph' : 'usageEventsBestEffort';
      }
    } else {
      eventRaw = await store.queryUsageEventAnalytics({
        ...eventWindow(normalized), filters: normalized.filters, limit: normalized.sourceRowLimit
      });
      sourceRows = eventRaw.rows.map(toEventRow);
      rowTruncated = eventRaw.truncated || eventRaw.rows.length > normalized.sourceRowLimit;
    }
    rowTruncated ||= sourceRows.length > normalized.sourceRowLimit;
    sourceRows = sourceRows.slice(0, normalized.sourceRowLimit);
    const aggregated = aggregateSourceRows(sourceRows, normalized);
    const totalValues = newAggregate();
    for (const sourceRow of sourceRows) aggregateInto(totalValues, sourceRow);
    const totals = Object.fromEntries(normalized.metrics.map((metric) => [metric, totalValues[metric]]));
    const sorted = aggregated.slice().sort((left, right) => compareRows(left, right, normalized.sort, normalized.order));
    const start = cursorPosition(normalized, sorted);
    const rows = sorted.slice(start, start + normalized.limit);
    const actualDates = [...new Set(sourceRows.map((row) => bucketValue(row, 'day', normalized.timeZone)).filter(Boolean))].sort();
    const matchedCoverageDays = new Set(coverageDays.map((day) => `${day.deviceId ?? day.device_id}\u0000${day.day_key || day.date}`)).size;
    const componentUnavailable = aggregated.some((row) => row.componentCoverage === 'partial');
    const costUnavailable = normalized.metrics.includes('costUsd') && totalValues.costUsd === null;
    const bestEffort = source !== 'tokscaleGraph';
    const resultWithoutRevision = {
      source,
      bestEffort,
      sourceSelection: source === 'mixed' ? 'dailyFacts+usageEventsBestEffort' : source === 'tokscaleGraph' ? 'dailyFacts' : 'usageEvents',
      timeBasis: source === 'mixed' ? 'mixed' : source === 'tokscaleGraph' ? 'producerCalendarDay' : normalized.bucket === 'hour' ? 'recordedAt' : 'recordedAtDay',
      timeZone: source === 'tokscaleGraph' && !normalized.explicitTimeZone ? 'producer' : normalized.timeZone,
      requestedRange: { startDate: normalized.startDate, endDate: normalized.endDate },
      actualRange: {
        startDate: actualDates[0] || null,
        endDate: actualDates.at(-1) || null,
        matchedDays: actualDates.length
      },
      bucket: normalized.bucket,
      groupBy: normalized.groupBy,
      metrics: normalized.metrics,
      filters: normalized.filters,
      coverage: {
        requestedDays: normalized.days.length,
        reportedDays: actualDates.length,
        coveredPartitions: matchedCoverageDays,
        matchedDays: actualDates.length,
        missingDays: Math.max(0, normalized.days.length - actualDates.length),
        sourceRows: sourceRows.length,
        componentUnavailable,
        costUnavailable
      },
      truncated: rowTruncated || start + rows.length < sorted.length,
      returned: rows.length,
      totalRows: sorted.length,
      nextCursor: start + rows.length < sorted.length && rows.length ? encodeCursor(normalized, rows.at(-1)) : null,
      sort: normalized.sort,
      order: normalized.order,
      metricSemantics: metricDescriptions(normalized, source, componentUnavailable, costUnavailable),
      totals,
      rows
    };
    const breakdown = topBreakdown(aggregated, normalized);
    resultWithoutRevision.breakdown = breakdown.rows;
    resultWithoutRevision.topN = { top: normalized.top, otherGroups: breakdown.otherCount };
    const seriesRows = sorted.filter((row) => row.bucket);
    resultWithoutRevision.series = seriesRows.slice(0, SERIES_POINT_LIMIT);
    resultWithoutRevision.truncated ||= rowTruncated || seriesRows.length > SERIES_POINT_LIMIT || start + rows.length < sorted.length;
    const revision = crypto.createHash('sha256').update(JSON.stringify(resultWithoutRevision)).digest('hex').slice(0, 32);
    return { ...resultWithoutRevision, revision };
  }
  return { query };
}

module.exports = {
  DEFAULT_METRICS,
  MAX_RANGE_DAYS,
  RESPONSE_ROW_LIMIT,
  SOURCE_ROW_LIMIT,
  analyticsCsv,
  compareRows,
  createUsageAnalyticsService,
  csvCell,
  normalizeAnalyticsQuery
};
