import db from '../db.js';

export const DISCOVERY_RULE_VERSION = 'elderly-discovery.2026-11.v1';
export const MEASUREMENT_ALERT_RULES = Object.freeze({
  bp: { sys: 180, dia: 120, unit: 'mmHg', source: 'https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings/when-to-call-911-for-high-blood-pressure', scope: '成人家庭血压复测提醒，产品在等于阈值时也提醒' },
  glucose: { low: 3.9, very_low: 3, unit: 'mmol/L', source: 'https://diabetesjournals.org/care/article/49/Supplement_1/S132/163927/6-Glycemic-Goals-Hypoglycemia-and-Hyperglycemic', scope: '成人血糖健康管理，按美国糖尿病协会 2026 分级数值显示提醒' },
  spo2: { low: 90, unit: '%', source: 'https://medlineplus.gov/lab-tests/pulse-oximetry/', scope: '成人血氧复测工程阈值，须考虑设备误差和个人基线' },
  temp: { high: 39, unit: '℃', source: 'https://www.medlineplus.gov/ency/article/003090.htm', scope: '成人家用体温复测工程阈值，来源提供背景，提醒值为项目设定' },
});

function recentlyCreated(userId, eventKey) {
  return db.prepare(`SELECT id FROM discovery_events WHERE user_id = ? AND event_key = ?
    AND status<>'superseded' AND created_at >= datetime('now','-1 day') LIMIT 1`).get(userId, eventKey);
}

export function createDiscoveryEvent(userId, event, sourceType, sourceId = null) {
  if (recentlyCreated(userId, event.key)) return null;
  const row = db.prepare(`INSERT INTO discovery_events
    (user_id,event_key,kind,severity,title,message,action,source_type,source_id,rule_version)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(userId, event.key, event.kind, event.severity, event.title,
      event.message, event.action, sourceType, sourceId, DISCOVERY_RULE_VERSION);
  const id = Number(row.lastInsertRowid);
  db.prepare(`INSERT INTO alerts (user_id,metric_type,severity,title,message,status,source_ref,rule_version,rule_key,evidence_metric_ids)
    VALUES (?,?,?,?,?,'pending',?,?,?,?)`)
    .run(userId, event.metric || null, event.severity, event.title, event.message, 'discovery:' + id, DISCOVERY_RULE_VERSION, event.key,
      sourceType === 'metric' ? JSON.stringify([sourceId]) : null);
  return id;
}

export function supersedeMeasurementAlerts(userId, metricId) {
  db.prepare(`UPDATE alerts SET status='resolved' WHERE user_id=? AND status IN ('pending','acknowledged')
    AND EXISTS (SELECT 1 FROM json_each(alerts.evidence_metric_ids) WHERE value=?)`).run(userId, metricId);
  db.prepare(`UPDATE discovery_events SET status='superseded' WHERE user_id=? AND source_type='metric' AND source_id=?`).run(userId, metricId);
}

export function discoverFromIntake(userId, intakeId, answers, scores) {
  const events = [];
  if (['stroke_face','stroke_arm','stroke_speech'].some(key => Number(answers[key]) === 1)) {
    events.push({ key: 'urgent.stroke_signs', kind: 'symptom', severity: 'critical', title: '发现突发卒中警示信号',
      message: '请立即呼叫急救并记录症状开始时间，不要等待预测结果或自行驾车。', action: '立即呼叫急救', todo: null });
  }
  if (Number(answers.chest_pain) === 1) {
    events.push({ key: 'urgent.chest_pain', kind: 'symptom', severity: 'critical', title: '发现胸痛或明显气短警示信号',
      message: '请立即寻求急救帮助，不要等待预测结果。', action: '立即呼叫急救', todo: null });
  }
  if (Number(scores.fall_down) === 1) events.push({ key: 'followup.fall', kind: 'screening', severity: 'warning', title: '近期有跌倒记录',
    message: '建议检查居家环境、用药和步态，并安排跌倒风险评估。', action: '安排跌倒风险评估', todo: '完成跌倒风险评估' });
  if (Number(answers.memory_concern) === 1) events.push({ key: 'followup.memory', kind: 'screening', severity: 'warning', title: '记忆或思考能力有变化',
    message: '这不是认知诊断，建议由专业人员完成规范认知筛查。', action: '预约规范认知筛查', todo: '咨询规范认知筛查' });
  if (Number(scores.cesd10) >= 10) events.push({ key: 'followup.mood', kind: 'screening', severity: 'warning', title: '近期情绪困扰值得关注',
    message: '问卷提示近期情绪困扰，建议与家人或专业人员沟通。', action: '联系家人或专业人员', todo: '关注近期情绪并寻求支持' });
  return events.map(event => ({ ...event, id: createDiscoveryEvent(userId, event, 'health_intake', intakeId) })).filter(event => event.id);
}

export function discoverFromMeasurement(userId, row) {
  const value = Number(row.value);
  const value2 = Number(row.value2);
  let event = null;
  const rule = MEASUREMENT_ALERT_RULES[row.type];
  if (row.type === 'bp' && (value >= rule.sys || value2 >= rule.dia)) event = {
    key: 'measurement.bp.very_high', kind: 'measurement', severity: 'warning', metric: 'bp', title: '血压读数很高，请规范复测',
    message: '请静坐休息后按相同条件复测；若同时出现胸痛、呼吸困难、意识或肢体异常，应立即呼叫急救。', action: '静坐后复测血压', todo: '静坐休息后复测血压' };
  else if (row.type === 'spo2' && value < rule.low) event = {
    key: 'measurement.spo2.low', kind: 'measurement', severity: 'critical', metric: 'spo2', title: '血氧读数明显偏低',
    message: '请确认设备佩戴并立即复测；如仍偏低或伴明显气短、口唇发紫，请立即寻求急救帮助。', action: '立即复测并视症状求助', todo: '立即复测血氧' };
  else if (row.type === 'glucose' && value < rule.low) event = {
    key: 'measurement.glucose.low', kind: 'measurement', severity: value < rule.very_low ? 'critical' : 'warning', metric: 'glucose', title: '血糖读数偏低',
    message: '请按既有低血糖处理方案及时处理并复测；意识不清或无法进食时应立即求助。', action: '按既有方案处理并复测', todo: '复测血糖' };
  else if (row.type === 'temp' && value >= rule.high) event = {
    key: 'measurement.temp.high', kind: 'measurement', severity: 'warning', metric: 'temp', title: '体温明显升高',
    message: '请复测体温并留意意识、呼吸和进食情况，持续高热或明显不适时尽快就医。', action: '复测并联系专业人员', todo: '复测体温' };
  return event ? createDiscoveryEvent(userId, event, 'metric', row.id) : null;
}

export function latestDiscoveryEvents(userId, limit = 10) {
  return db.prepare(`SELECT * FROM discovery_events WHERE user_id = ? AND status = 'open'
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, id DESC LIMIT ?`).all(userId, limit);
}
