import { assessQuality, researchMetricTypes } from './qualityPolicy.js';

export const TEMPORAL_VERSION = 'temporal-memory.v3.1';
export const DAY_MS = 86_400_000;
const LOCAL_OFFSET = 8 * 3_600_000;
export const MAX_LOOKBACK = 730;
export const METRIC_LABELS = {
  bp: '血压', glucose: '血糖', hr: '心率', spo2: '血氧', sleep: '睡眠', weight: '体重', steps: '步数',
};
const PHYSIOLOGICAL = new Set(['bp', 'glucose', 'hr']);
const TTL_DAYS = { profile: 365, event: 30, trend: 60, feedback: 120, conflict: 30 };
const SOURCE_WEIGHT = { device: 1, clinician: 1, manual: 0.75, caregiver_report: 0.6, self_report: 0.75, confirmed: 1 };
// Frozen after the V3 validation grid. Weights order: relevance, time, quality, provenance.
export const TEMPORAL_DEFAULT = Object.freeze({ weights: Object.freeze([0.2, 0.25, 0.35, 0.2]), threshold: 0.55, halfLife: 15 });
const decimal = value => Math.round(value * 100) / 100;

export function parseRecordedTime(value) {
  if (typeof value !== 'string') return NaN;
  const local = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  return Date.parse(local ? local[1] + 'T' + local[2] + '+08:00' : value);
}

export const localDay = time => new Date(time + LOCAL_OFFSET).toISOString().slice(0, 10);
const dayStart = (y, m, d) => Date.UTC(y, m - 1, d) - LOCAL_OFFSET;
const localYearMonthDay = time => localDay(time).split('-').map(Number);
const iso = time => new Date(time).toISOString();
const windowFor = (from, to, label) => ({ from, to, label });
const calendarDate = (year, month, date) => {
  const day = dayStart(year, month, date);
  return localYearMonthDay(day).every((value, index) => value === [year, month, date][index]) ? day : NaN;
};

export function resolveWindows(text, now) {
  const [year, month, date] = localYearMonthDay(now);
  const today = dayStart(year, month, date);
  const tomorrow = today + DAY_MS;
  const windows = [];
  const emit = (from, to, label) => windows.push(windowFor(from, to, label));
  const dates = [...text.matchAll(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日|号)?/g)];
  if (dates.length) {
    for (let i = 0; i < dates.length; i++) {
      const row = dates[i];
      const start = calendarDate(...row.slice(1, 4).map(Number));
      const next = dates[i + 1];
      const connector = next && text.slice(row.index + row[0].length, next.index).trim();
      if (connector && /^(至|到|~|～|—|－|–)$/.test(connector)) {
        emit(start, calendarDate(...next.slice(1, 4).map(Number)) + DAY_MS, row[0] + '至' + next[0]);
        i++;
      } else emit(start, start + DAY_MS, row[0]);
    }
  } else {
    for (const found of text.matchAll(/(\d{4})[-年](\d{1,2})(?:月|(?=\D|$))/g)) {
      const [y, m] = found.slice(1, 3).map(Number);
      emit(calendarDate(y, m, 1), dayStart(y, m + 1, 1), y + '年' + m + '月');
    }
    const months = [
      [/上上个?月|前一个月/, -2, '上上月'], [/上个?月|上个月/, -1, '上月'], [/这个月|本月|当月/, 0, '本月'],
    ];
    for (const [pattern, delta, label] of months) {
      const cleaned = delta === -1 ? text.replace(/上上个?月/g, '') : text;
      if (pattern.test(cleaned)) emit(dayStart(year, month + delta, 1), dayStart(year, month + delta + 1, 1), label);
    }
    const weekday = (new Date(today + LOCAL_OFFSET).getUTCDay() + 6) % 7;
    const monday = today - weekday * DAY_MS;
    if (/上周/.test(text)) emit(monday - 7 * DAY_MS, monday, '上周');
    if (/本周|这周/.test(text)) emit(monday, monday + 7 * DAY_MS, '本周');
    for (const match of text.matchAll(/(近\s*|最近\s*|过去\s*|此前\s*)(\d{1,4})\s*天/g)) {
      const days = Number(match[2]);
      const end = match[1].trim() === '此前' ? windows.at(-1)?.from : tomorrow;
      emit(end - days * DAY_MS, end, match[0]);
    }
    if (/昨天/.test(text)) emit(today - DAY_MS, today, '昨天');
    if (/今天/.test(text)) emit(today, tomorrow, '今天');
    const yearMonths = [...text.matchAll(/(去年|今年)(\d{1,2})月/g)];
    for (const found of yearMonths) {
      const y = found[1] === '去年' ? year - 1 : year;
      const m = Number(found[2]);
      emit(calendarDate(y, m, 1), dayStart(y, m + 1, 1), y + '年' + m + '月');
    }
    if (/去年(?!\d{1,2}月)/.test(text)) emit(dayStart(year - 1, 1, 1), dayStart(year, 1, 1), '去年');
  }
  const invalid = windows.length > 4 || windows.some(({ from, to }) => !Number.isFinite(from) || !Number.isFinite(to) ||
    from >= to || from > now || to - from > MAX_LOOKBACK * DAY_MS || from < today - MAX_LOOKBACK * DAY_MS);
  const unique = [...new Map(windows.map(row => [row.from + ':' + row.to, row])).values()];
  return { windows: invalid ? [] : unique, invalid };
}

export function temporalRequest(question, now) {
  const text = String(question);
  const metrics = researchMetricTypes(text);
  const metric = metrics[0] || null;
  const { windows, invalid } = resolveWindows(text, now);
  const timeCue = windows.length || invalid || /以前|过去|长期|历史|当时|跨月|记忆|上次|此前/.test(text);
  const adjustment = /反馈|没坚持|漏做|上次计划|上次的计划/.test(text) && /调整|改进|怎么做|建议/.test(text);
  const draft = /历史|上次计划|上次的计划/.test(text) && /制定|生成|草案/.test(text) && /方案|计划|草案/.test(text);
  if (/诊断|确诊|处方|未来|预测|概率|风险|数据质量|单位对不对/.test(text)) return null;
  const mode = adjustment ? 'adjustment' : draft ? 'draft'
    : /档案记忆|已确认的偏好|长期档案/.test(text) ? 'profile'
      : /计划反馈|执行反馈|历史计划|计划前后|方案反馈/.test(text) ? 'feedback'
        : timeCue && /记录|读数|测量|趋势|变化|对比|比较|走向|走势|是多少|怎么样|数值|情况/.test(text) ?
          (/趋势|变化|对比|比较|走向|走势/.test(text) || windows.length > 1 ? 'trend' : 'events') : null;
  if (!mode) return null;
  const allowImplicit = ['profile', 'adjustment', 'draft'].includes(mode);
  const reason = invalid ? 'invalid_time' : metrics.length > 1 && mode !== 'profile' ? 'multiple_metrics'
    : !allowImplicit && !windows.length ? 'time_missing'
    : !metric && ['events', 'trend', 'draft'].includes(mode) ? 'metric_missing' : null;
  return { mode, metric, windows, reason, historical: windows.length > 0 };
}

export function aggregateWindow(events, metric, window, now, minimum = 3) {
  const until = Math.min(now, window.to - 1);
  const rows = events.filter(row => {
    const time = parseRecordedTime(row.recorded_at);
    return time >= window.from && time <= until;
  });
  const quality = assessQuality({ events: rows.map(row => ({ ...row, recorded_at: iso(parseRecordedTime(row.recorded_at)) })),
    metric, task: minimum === 1 ? 'summary' : 'trend',
    days: Math.max(1, (until - window.from) / DAY_MS + 0.000001), asOf: iso(until) });
  const invalid = new Set(['unit_error', 'noise', 'unknown_source', 'invalid_time', 'mixed_conditions', 'missing_condition']);
  const issues = quality?.issues || [];
  const usableIds = new Set(quality?.evidence_ids || []);
  const usable = rows.filter(row => usableIds.has(row.id));
  const days = new Map();
  for (const row of usable) {
    const key = localDay(parseRecordedTime(row.recorded_at));
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(row);
  }
  const conditions = new Set(usable.map(row => row.measurement_condition));
  const state = issues.includes('conflict') ? 'conflict' : issues.some(issue => invalid.has(issue)) ? 'quality_limited'
    : days.size < minimum ? 'insufficient' : 'supported';
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const dailyMean = property => decimal(mean([...days.values()].map(group => mean(group.map(row => row[property])))));
  return {
    state, issues, points: rows.length, days: days.size, quality: (quality?.score || 0) / 100,
    sources: state === 'supported' ? usable : rows,
    condition: conditions.size === 1 ? [...conditions][0] : null,
    value: state === 'supported' ? dailyMean('value') : null,
    value2: state === 'supported' && metric === 'bp' ? dailyMean('value2') : null,
    unit: usable[0]?.unit || null,
  };
}

export function canCompareWindows(metric, summaries) {
  return summaries.length > 1 && summaries.every(row => row.state === 'supported') &&
    (!PHYSIOLOGICAL.has(metric) || summaries.every(row => row.condition && row.condition === summaries[0].condition));
}

function tokens(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase();
  const words = normalized.match(/[a-z0-9]+/g) || [];
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
    if (run.length === 1) words.push(run);
  }
  return words;
}

function weightedVector(text, frequency, total) {
  const vector = new Map();
  for (const token of tokens(text)) vector.set(token, (vector.get(token) || 0) + 1);
  for (const [term, count] of vector) vector.set(term, (1 + Math.log(count)) * (1 + Math.log((1 + total) / (1 + (frequency.get(term) || 0)))));
  return vector;
}

function cosine(left, right) {
  const magnitude = vector => Math.sqrt([...vector.values()].reduce((sum, value) => sum + value ** 2, 0));
  const divisor = magnitude(left) * magnitude(right);
  if (!divisor) return 0;
  return [...left].reduce((sum, [term, weight]) => sum + weight * (right.get(term) || 0), 0) / divisor;
}

function overlap(item, window) {
  const end = item.end ?? item.at + 1;
  return item.at < window.to && end > window.from;
}

export function memoryUsability(item, request, now) {
  if (item.status === 'superseded' || item.status === 'removed' || item.at > now) return 'unavailable';
  if (request.metric && item.metric && request.metric !== item.metric) return 'different_metric';
  if (request.kinds && !request.kinds.includes(item.kind)) return 'different_kind';
  if (request.windows.length && !request.windows.some(window => overlap(item, window))) return 'wrong_window';
  if (item.kind === 'profile' && item.expires != null && now >= item.expires) return 'expired';
  if (!request.historical && now >= (item.expires ?? item.at + (TTL_DAYS[item.kind] ?? 30) * DAY_MS)) return 'expired';
  return item.status === 'conflict' ? 'conflict' : 'usable';
}

export function rankMemories(items, request, now, options = {}) {
  const { method = 'temporal', weights, threshold, halfLife, decay = true, conflicts = true, k = 5 } = { ...TEMPORAL_DEFAULT, ...options };
  const frequency = new Map();
  for (const item of items) for (const term of new Set(tokens(item.text))) frequency.set(term, (frequency.get(term) || 0) + 1);
  const query = weightedVector(request.query, frequency, items.length);
  const results = [];
  for (const item of items) {
    const usability = memoryUsability(item, request, now);
    if (method === 'temporal' && usability !== 'usable' && !(usability === 'conflict' && !conflicts)) continue;
    if (method === 'time_filter' && request.windows.length && !request.windows.some(window => overlap(item, window))) continue;
    const semantic = cosine(query, weightedVector(item.text, frequency, items.length));
    const reference = request.windows.length ? Math.min(now, request.windows.find(window => overlap(item, window))?.to ?? now) : now;
    const age = Math.max(0, (reference - Math.min(reference, item.end ?? item.at)) / DAY_MS);
    const time = decay ? 2 ** (-age / (halfLife * ((TTL_DAYS[item.kind] || 30) / 30))) : 1;
    const source = item.reliability ?? SOURCE_WEIGHT[item.source] ?? 0;
    const score = method === 'temporal' ? [semantic, time, item.quality, source].reduce((sum, value, i) => sum + value * weights[i], 0) : semantic;
    if (score >= (method === 'temporal' ? threshold : 0)) results.push({ ...item, score, usability });
  }
  return results.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id), 'en')).slice(0, k);
}

export function proposeAdjustment({ skips = 0, recorded = 0, matchedOutcome = false, burden = 'unknown' } = {}) {
  if (!recorded) return { code: 'collect_feedback', message: '请先记录执行情况和遇到的困难，再一起核对计划。' };
  if (burden === 'discomfort') return { code: 'review_discomfort', message: '收到不适反馈。先请专业人员核对身体情况和计划，再决定是否调整。' };
  if (burden === 'schedule' || skips > 0) return { code: 'review_schedule', message: '可以先核对哪几次没有完成、哪些时段更容易坚持。是否把记录或复测提醒改到方便的时间？' };
  if (!matchedOutcome) return { code: 'await_recheck', message: '已有执行记录。先在可比较的条件下补齐计划后的测量，再讨论是否调整。' };
  return { code: 'review_with_user', message: '可以一起复核执行、测量条件和前后记录，再决定是否维持现有观察方式。' };
}
