import express from 'express';
import db from '../db.js';
import { validateMeasurement, findDuplicateMeasurement, insertMeasurement } from '../lib/metricRecords.js';
import { discoverFromMeasurement } from '../lib/discovery.js';
import { matchMeasurementToFollowup } from '../lib/followups.js';
import { triggerTrendAlerts } from '../lib/trendAlerts.js';

const router = express.Router();

// ============= 设备 =============
router.get('/devices', (req, res) => {
  const rows = db.prepare(`SELECT * FROM devices WHERE user_id = ?`).all(req.user.id);
  res.json(rows);
});

router.post('/devices', (req, res) => {
  const { name, kind, battery_level, bluetooth_id } = req.body || {};
  if (!name || !kind) return res.status(400).json({ error: 'name and kind are required' });
  const battery = battery_level == null ? null : Math.max(0, Math.min(100, Number(battery_level)));
  const bluetoothId = bluetooth_id ? String(bluetooth_id).slice(0, 200) : null;
  if (bluetoothId) {
    const existing = db.prepare('SELECT * FROM devices WHERE user_id = ? AND bluetooth_id = ?').get(req.user.id, bluetoothId);
    if (existing) {
      db.prepare('UPDATE devices SET name = ?, kind = ?, status = ?, battery_level = COALESCE(?, battery_level), sync_error = NULL WHERE id = ? AND user_id = ?')
        .run(String(name).slice(0, 80), String(kind).slice(0, 40), 'connected', Number.isFinite(battery) ? battery : null, existing.id, req.user.id);
      return res.json(db.prepare('SELECT * FROM devices WHERE id = ?').get(existing.id));
    }
  }
  const r = db.prepare('INSERT INTO devices (user_id, name, kind, status, battery_level, bluetooth_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, String(name).slice(0, 80), String(kind).slice(0, 40), 'connected', Number.isFinite(battery) ? battery : null, bluetoothId);
  res.status(201).json(db.prepare('SELECT * FROM devices WHERE id = ?').get(r.lastInsertRowid));
});

router.patch('/devices/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!device) return res.status(404).json({ error: 'device not found' });
  const fields = []; const values = [];
  if (req.body.status !== undefined && ['connected', 'disconnected', 'error'].includes(req.body.status)) { fields.push('status = ?'); values.push(req.body.status); }
  if (req.body.battery_level !== undefined) { const b = Number(req.body.battery_level); if (Number.isFinite(b) && b >= 0 && b <= 100) { fields.push('battery_level = ?'); values.push(Math.round(b)); } }
  if (req.body.sync_error !== undefined) { fields.push('sync_error = ?'); values.push(req.body.sync_error ? String(req.body.sync_error).slice(0, 240) : null); }
  if (!fields.length) return res.json(device);
  values.push(id, req.user.id);
  db.prepare(`UPDATE devices SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM devices WHERE id = ?').get(id));
});

// 真实 Web Bluetooth 与模拟设备共用这一入库接口，统一写入 metrics.source=device。
router.post('/devices/:id/sync', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!device) return res.status(404).json({ error: 'device not found' });
  const { battery_level } = req.body || {};
  const markError = (message) => { db.prepare('UPDATE devices SET status = ?, sync_error = ? WHERE id = ? AND user_id = ?').run('error', String(message).slice(0, 240), id, req.user.id); };
  const input = validateMeasurement(req.body || {});
  if (input.error) {
    const legacyErrors = {
      invalid_metric_or_value: 'unsupported metric or invalid value',
      outside_physical_range: 'value outside physical range',
      missing_secondary_value: 'invalid secondary metric value',
      secondary_outside_physical_range: 'invalid secondary metric value',
    };
    const error = legacyErrors[input.flags[0]] || input.error;
    markError(error);
    return res.status(400).json({ error, flags: input.flags });
  }
  const result = db.transaction(() => {
    const duplicate = findDuplicateMeasurement(req.user.id, input);
    if (duplicate) return { device, metric: duplicate, duplicate: true };
    const { row, quality } = insertMeasurement(req.user.id, req.user.id, input, 'device', id);
    const battery = battery_level == null ? device.battery_level : Number(battery_level);
    db.prepare('UPDATE devices SET status = ?, last_sync = ?, battery_level = ?, sync_error = NULL WHERE id = ? AND user_id = ?')
      .run('connected', new Date().toISOString(), Number.isFinite(battery) ? Math.max(0, Math.min(100, battery)) : device.battery_level, id, req.user.id);
    discoverFromMeasurement(req.user.id, row);
    matchMeasurementToFollowup(req.user.id, row);
    return { device: db.prepare('SELECT * FROM devices WHERE id = ?').get(id), metric: row, quality };
  }).immediate();
  if (!result.duplicate) triggerTrendAlerts(req.user.id, input.type).catch(error => console.error('[trend-alert] analysis failed:', error.code || 'unknown'));
  res.status(result.duplicate ? 200 : 201).json(result);
});

export default router;
