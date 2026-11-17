// 健康数据路由
import express from 'express';
import db from '../db.js';
import { evaluateHealth } from '../lib/scoring.js';
import { triggerTrendAlerts, TREND_ALERT_RULE_VERSION } from '../lib/trendAlerts.js';
import { discoverFromMeasurement, supersedeMeasurementAlerts, DISCOVERY_RULE_VERSION, MEASUREMENT_ALERT_RULES } from '../lib/discovery.js';
import { resolveCareAccess } from '../contracts/careAccess.js';
import { appendAuditEvent } from '../repositories/auditRepository.js';
import { validateMeasurement, measurementQuality, findDuplicateMeasurement, insertMeasurement, summarizeMeasurementGroups } from '../lib/metricRecords.js';
import { matchMeasurementToFollowup, reconcileFollowupsForMeasurement } from '../lib/followups.js';
import { parseHealthDescription } from '../lib/healthTextParser.js';

const router = express.Router();

function subjectAccess(req, res, rawId, scope) {
  if (rawId == null) return req.user.id;
  const access = resolveCareAccess(rawId, req.user.id, scope, { resource: req.originalUrl.split('?')[0] });
  if (access.allowed) return Number(rawId);
  res.status(access.status).json({ error: access.message, code: access.reason });
  return null;
}

const selectMeasurement = db.prepare('SELECT * FROM metrics WHERE id=? AND user_id=?');
const editFields = ['value', 'value2', 'unit', 'recorded_at', 'note', 'measurement_condition'];

function auditMeasurement(req, row, action, metadata = {}) {
  appendAuditEvent({
    actor_user_id: req.user.id, subject_user_id: row.user_id, event_type: 'health_measurement',
    resource: 'measurement:' + row.id, action, request_id: req.request_id,
    metadata: { record_id: row.id, type: row.type, revision: row.revision, ...metadata },
  });
}

function analyzeMeasurement(row) {
  if (row.source !== 'synthetic') {
    triggerTrendAlerts(row.user_id, row.type).catch(error => console.error('[trend-alert] analysis failed:', error.code || 'unknown'));
  }
}

// 指标定义（单一数据源：metric_defs 表）
router.get('/metric-defs', (_req, res) => {
  const defs = db.prepare(`
    SELECT type, name, unit, value_type, min_value, max_value, normal_min, normal_max,
           frequency, ml_enabled, prediction_mode, description, color, icon, sort
    FROM metric_defs ORDER BY sort
  `).all();
  res.json(defs);
});

router.get('/alert-rules', (_req, res) => {
  res.json({
    measurement: { version: DISCOVERY_RULE_VERSION, rules: MEASUREMENT_ALERT_RULES },
    trend: { version: TREND_ALERT_RULE_VERSION, window_days: 90, source: 'healthTrend.js / curve engine',
      scope: '基于实际历史数据和可用趋势分析输出的工程提醒，未作为临床诊断规则使用。' },
  });
});

// 获取今日健康摘要：得分 + 子项 + 子项卡 + 待办数 + 预警数
router.get('/summary', (req, res) => {
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 3600 * 1000);

  const metrics = db.prepare(`
    SELECT * FROM metrics
    WHERE user_id = ?
      AND recorded_at >= ?
    ORDER BY recorded_at DESC
  `).all(req.user.id, sevenDaysAgo.toISOString());

  // todo 完成率
  const todayDate = today.toISOString().slice(0, 10);
  const todos = db.prepare(`
    SELECT * FROM todos WHERE user_id = ? AND date = ?
  `).all(req.user.id, todayDate);
  const todoCompletionRate = todos.length
    ? todos.filter(t => t.completed).length / todos.length
    : 0;

  const evaluation = evaluateHealth(metrics, { todoCompletionRate, height: req.user.height });
  const alerts = db.prepare(`
    SELECT * FROM alerts WHERE user_id = ? AND status = 'pending'
  `).all(req.user.id);

  const { password: _, ...safeUser } = req.user;
  res.json({
    user: safeUser,
    today: todayDate,
    total_score: evaluation.total_score,
    subscores: evaluation.subscores,
    scoring_details: evaluation.scoring_details,
    summary: evaluation.summary,
    todo_count: todos.length,
    todo_completed: todos.filter(t => t.completed).length,
    alert_count: alerts.length,
  });
});

// 获取所有指标的最新值（内置 + 用户自定义）
router.get('/metrics', (req, res) => {
  // 内置指标列表来自 metric_defs（vision/hearing 已移出核心体系）
  const builtInTypes = db.prepare('SELECT type FROM metric_defs ORDER BY sort').all().map(r => r.type);
  const result = {};
  for (const t of builtInTypes) {
    const row = db.prepare(`
      SELECT * FROM metrics
      WHERE user_id = ? AND type = ?
      ORDER BY recorded_at DESC LIMIT 1
    `).get(req.user.id, t);
    result[t] = row || null;
  }
  // 用户自定义指标
  const customs = db.prepare('SELECT * FROM custom_metrics WHERE user_id = ?').all(req.user.id);
  for (const c of customs) {
    const key = 'custom_' + c.id;
    const row = db.prepare(`
      SELECT * FROM metrics
      WHERE user_id = ? AND type = ?
      ORDER BY recorded_at DESC LIMIT 1
    `).get(req.user.id, key);
    result[key] = row ? { ...row, custom_name: c.name, custom_unit: c.unit, custom_icon: c.icon, custom_color: c.color } : null;
  }
  res.json(result);
});

// 单项历史
router.get('/metrics/:type/history', (req, res) => {
  const { type } = req.params;
  const days = Number(req.query.days ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return res.status(400).json({ error: '查询天数须为 1 至 365 的整数。' });
  }
  const subject = subjectAccess(req, res, req.query.subject_user_id, 'view_trends');
  if (subject == null) return;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare(`
    SELECT * FROM metrics
    WHERE user_id = ? AND type = ? AND recorded_at >= ?
    ORDER BY recorded_at ASC,id ASC
  `).all(subject, type, since);
  res.json({ type, days, subject_user_id: subject, points: rows, statistics: summarizeMeasurementGroups(rows) });
});

router.get('/metrics/:id', (req, res) => {
  const subject = subjectAccess(req, res, req.query.subject_user_id, 'view_trends');
  if (subject == null) return;
  const id = Number(req.params.id);
  const row = Number.isSafeInteger(id) && selectMeasurement.get(id, subject);
  if (!row) return res.status(404).json({ error: '健康测量记录不存在。' });
  res.json(row);
});

// 录入 / 更新指标
// source: manual（用户录入，默认）| device（真实设备）| synthetic（演示/测试）
router.post('/metrics/parse-description', (req, res) => {
  try {
    const text = String(req.body?.text ?? '');
    if (!text.trim()) return res.status(400).json({ error: '请先输入或说出健康数据', code: 'EMPTY_DESCRIPTION' });
    res.json(parseHealthDescription(text));
  } catch (error) {
    if (error?.message === 'TEXT_TOO_LONG') return res.status(400).json({ error: '描述过长，请控制在2000字以内', code: 'DESCRIPTION_TOO_LONG' });
    console.error('[health-text-parser] failed:', error);
    return res.status(500).json({ error: '暂时无法识别这段描述，请稍后重试', code: 'PARSER_FAILED' });
  }
});

router.post('/metrics', (req, res) => {
  const body = req.body || {};
  const subject = subjectAccess(req, res, body.subject_user_id, 'record_measurements');
  if (subject == null) return;
  const delegated = subject !== req.user.id;
  const source = delegated ? 'caregiver_report' : ['device', 'synthetic'].includes(body.source) ? body.source : 'manual';
  let deviceId = null;
  if (source === 'device') {
    const device = db.prepare('SELECT id FROM devices WHERE id=? AND user_id=?').get(Number(body.device_id) || 0, subject);
    if (!device) return res.status(400).json({ error: '请选择属于本人的设备，或按手工记录保存。' });
    deviceId = device.id;
  }
  const input = validateMeasurement(body);
  if (input.error) return res.status(400).json({
    error: input.flags[0] === 'invalid_metric_or_value' ? 'unsupported metric or invalid value' : 'invalid measurement',
    message: input.error, flags: input.flags,
  });
  const result = db.transaction(() => {
    const duplicate = findDuplicateMeasurement(subject, input, 0, delegated ? req.user.id : null);
    if (duplicate) return { duplicate: true, row: duplicate };
    const saved = insertMeasurement(subject, req.user.id, input, source, deviceId);
    auditMeasurement(req, saved.row, 'create');
    const followup = source === 'synthetic' ? null : matchMeasurementToFollowup(subject, saved.row);
    if (source !== 'synthetic') discoverFromMeasurement(subject, saved.row);
    return { ...saved, followup };
  }).immediate();
  if (result.duplicate) {
    // A write-only delegation cannot disclose an existing measurement or its provenance.
    const previous = delegated ? { id: result.row.id, duplicate: true } : { ...result.row, duplicate: true };
    return res.json({ ...previous, quality: { valid: true, duplicate: true, flags: ['duplicate_measurement'] } });
  }
  analyzeMeasurement(result.row);
  res.json({ ...result.row, quality: result.quality, followup_match: delegated ? null : result.followup });
});

function mutateMeasurement(req, res) {
  const id = Number(req.params.id);
  const deleting = req.method === 'DELETE';
  const body = req.body || {};
  const revision = Number(body.revision);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(revision) || revision < 1) {
    return res.status(400).json({ error: '请重新读取记录及其版本后再提交。' });
  }
  if (body.subject_user_id != null && Number(body.subject_user_id) !== req.user.id) {
    return res.status(403).json({ error: '只能修改或删除自己的测量记录。' });
  }
  const result = db.transaction(() => {
    const original = selectMeasurement.get(id, req.user.id);
    if (!original) return { status: 404, error: '健康测量记录不存在。' };
    if (original.revision !== revision) return { status: 409, error: '记录已更新，请刷新后再操作。' };
    if (deleting) {
      reconcileFollowupsForMeasurement(original.user_id, id, true);
      supersedeMeasurementAlerts(original.user_id, id);
      db.prepare('DELETE FROM metrics WHERE id=? AND user_id=?').run(id, original.user_id);
      auditMeasurement(req, original, 'delete');
      return { row: original, reanalyze: true };
    }
    const fields = editFields.filter(field => Object.hasOwn(body, field));
    if (!fields.length) return { status: 400, error: '请提交需要修正的测量字段。' };
    if (fields.includes('recorded_at') && !body.recorded_at) return { status: 400, error: '测量时间不能为空。' };
    if (fields.length === 1 && fields[0] === 'note') {
      const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;
      if (note === original.note) return { row: original };
      const row = db.prepare(`UPDATE metrics SET note=?,revision=revision+1,updated_at=? WHERE id=? RETURNING *`)
        .get(note, new Date().toISOString(), id);
      auditMeasurement(req, row, 'update', { fields });
      return { row };
    }
    const edits = Object.fromEntries(fields.map(field => [field, body[field]]));
    const input = validateMeasurement({ ...original, ...edits });
    if (input.error) return { status: 400, ...input };
    if (input.unit !== original.unit && fields.includes('unit') && !fields.includes('value')) {
      return { status: 400, error: '修正单位时，请一起核对并提交测量数值。' };
    }
    const changed = editFields.filter(field => (input[field] ?? null) !== (original[field] ?? null));
    if (!changed.length) return { row: original };
    const measurementChanged = changed.some(field => field !== 'note');
    if (measurementChanged && findDuplicateMeasurement(original.user_id, input, id)) {
      return { status: 409, error: '已存在相同的测量，请核对记录后重试。' };
    }
    const quality = measurementQuality(input, original.source, original.device_id);
    const row = db.prepare(`UPDATE metrics SET value=?,value2=?,unit=?,recorded_at=?,note=?,measurement_condition=?,
      data_quality=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? RETURNING *`).get(
      input.value, input.value2, input.unit, input.recorded_at, input.note, input.measurement_condition,
      JSON.stringify(quality), new Date().toISOString(), id, original.user_id,
    );
    auditMeasurement(req, row, 'update', { fields: changed });
    if (measurementChanged) {
      reconcileFollowupsForMeasurement(original.user_id, id);
      supersedeMeasurementAlerts(original.user_id, id);
      if (row.source !== 'synthetic') discoverFromMeasurement(original.user_id, row);
    }
    return { row, reanalyze: measurementChanged };
  }).immediate();
  if (result.error) return res.status(result.status).json({ error: result.error, flags: result.flags });
  if (result.reanalyze) analyzeMeasurement(result.row);
  res.json(deleting ? { ok: true, id } : result.row);
}

router.patch('/metrics/:id', mutateMeasurement);
router.delete('/metrics/:id', mutateMeasurement);

export default router;
