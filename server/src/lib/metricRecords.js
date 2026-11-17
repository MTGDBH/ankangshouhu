import db from '../db.js';

const CONDITION_ALIASES = {
  fasting: 'fasting', '空腹': 'fasting', '空腹血糖': 'fasting',
  postprandial_2h: 'postprandial_2h', postprandial: 'postprandial_2h', '餐后': 'postprandial_2h', '餐后2小时': 'postprandial_2h',
  random: 'random', '随机': 'random', resting: 'resting', '静息': 'resting', '静息心率': 'resting',
  active: 'active', '活动': 'active', morning_rest: 'morning_rest', '晨起': 'morning_rest', '早晨静息': 'morning_rest',
  evening_rest: 'evening_rest', '晚间静息': 'evening_rest', '晚上静息': 'evening_rest',
  morning_fasting: 'morning_fasting', '晨起空腹': 'morning_fasting', other: 'other', unknown: 'unknown',
};
const CONDITIONS = {
  glucose: ['fasting', 'postprandial_2h', 'random'], hr: ['resting', 'active'],
  bp: ['morning_rest', 'evening_rest', 'other'], weight: ['morning_fasting', 'other'],
};

function normalizeCondition(type, value) {
  const normalized = CONDITION_ALIASES[String(value ?? '').trim().toLowerCase()];
  return typeof normalized === 'string' && (CONDITIONS[type] || ['other']).includes(normalized) ? normalized : 'unknown';
}

function asNumber(value) {
  return typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
}

export function validateMeasurement(input) {
  const definition = typeof input.type === 'string' && db.prepare('SELECT * FROM metric_defs WHERE type=?').get(input.type);
  const value = asNumber(input.value);
  if (!definition || !Number.isFinite(value)) return { error: '请选择支持的指标并填写有效数值。', flags: ['invalid_metric_or_value'] };
  const type = definition.type;
  const flags = [];
  if ((definition.min_value != null && value < definition.min_value) || (definition.max_value != null && value > definition.max_value)) flags.push('outside_physical_range');
  const value2 = definition.value_type === 'dual' ? asNumber(input.value2) : null;
  if (value2 !== null && !Number.isFinite(value2)) flags.push('missing_secondary_value');
  if (value2 !== null && (value2 < 30 || value2 > 180)) flags.push('secondary_outside_physical_range');
  const timestamp = input.recorded_at == null || input.recorded_at === '' ? Date.now() : Date.parse(input.recorded_at);
  if (!Number.isFinite(timestamp)) flags.push('invalid_timestamp');
  else if (timestamp > Date.now() + 5 * 60_000) flags.push('future_timestamp');
  const canonicalUnit = definition.unit || '';
  const aliases = { hr: ['次/分', '次/分钟'], sleep: ['h', '小时'], spo2: ['％'], steps: ['steps'], temp: ['°C', '℃'] };
  const unit = String(input.unit ?? '').trim();
  if (unit && unit.toLowerCase() !== canonicalUnit.toLowerCase() && !aliases[type]?.includes(unit)) flags.push('unit_mismatch');
  if (flags.length) return { error: '请核对测量数值、单位和时间。', flags };
  const context = input.measurement_context;
  const safeContext = context && typeof context === 'object' && !Array.isArray(context)
    ? Object.fromEntries(Object.entries(context).filter(([key, val]) => /^[a-z_]{1,40}$/.test(key) && ['string','number','boolean'].includes(typeof val))
      .slice(0, 12).map(([key, val]) => [key, typeof val === 'string' ? val.slice(0, 200) : val])) : {};
  return {
    type, value, value2, unit: canonicalUnit, recorded_at: new Date(timestamp).toISOString(),
    measurement_condition: normalizeCondition(type, input.measurement_condition),
    note: typeof input.note === 'string' ? input.note.slice(0, 500) : null,
    measurement_context: JSON.stringify(safeContext),
    timestamp_quality: input.recorded_at ? 'provided' : 'server_time',
  };
}

export function measurementQuality(input, source, deviceId = null) {
  return {
    valid: true, duplicate: false, flags: [], source, device_id: deviceId,
    timestamp_quality: input.timestamp_quality, condition_present: input.measurement_condition !== 'unknown',
    measurement_condition: input.measurement_condition,
  };
}

export function findDuplicateMeasurement(subjectId, input, exceptId = 0, actorId = null) {
  return db.prepare(`
    SELECT * FROM metrics WHERE user_id=? AND type=? AND id<>? AND value=? AND value2 IS ?
      AND abs(julianday(recorded_at) - julianday(?)) < (60.0 / 86400.0)
      AND COALESCE(measurement_condition,'unknown')=? AND (? IS NULL OR actor_user_id=?) ORDER BY id DESC LIMIT 1
  `).get(subjectId, input.type, exceptId, input.value, input.value2, input.recorded_at, input.measurement_condition, actorId, actorId);
}

export function insertMeasurement(subjectId, actorId, input, source, deviceId = null) {
  const quality = measurementQuality(input, source, deviceId);
  const now = new Date().toISOString();
  const row = db.prepare(`
    INSERT INTO metrics (id,user_id,actor_user_id,type,value,value2,unit,recorded_at,source,note,device_id,
      measurement_condition,data_quality,measurement_context,created_at,updated_at)
    VALUES ((SELECT last_id+1 FROM metric_id_sequence WHERE singleton=1),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    RETURNING *
  `).get(subjectId, actorId, input.type, input.value, input.value2, input.unit, input.recorded_at, source,
    input.note, deviceId, input.measurement_condition, JSON.stringify(quality), input.measurement_context, now, now);
  return { row, quality };
}

export function summarizeMeasurementGroups(points) {
  const groups = new Map();
  for (const point of points) {
    const condition = point.measurement_condition || 'unknown';
    const key = JSON.stringify([point.unit, condition]);
    if (!groups.has(key)) groups.set(key, { unit: point.unit, measurement_condition: condition, points: [] });
    groups.get(key).points.push(point);
  }
  function stats(rows, field) {
    let count = 0, sum = 0, min = Infinity, max = -Infinity;
    for (const row of rows) {
      const value = row[field];
      if (!Number.isFinite(value)) continue;
      count++;
      sum += value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    return count ? { count, min, max, mean: Number((sum / count).toFixed(4)) } : null;
  }
  return [...groups.values()].map(({ unit, measurement_condition, points: rows }) => ({
    unit, measurement_condition, record_ids: rows.map(row => row.id),
    value: stats(rows, 'value'), value2: stats(rows, 'value2'),
  }));
}
