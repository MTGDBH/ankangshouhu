import express from 'express';
import db from '../db.js';

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
  const { type, value, value2, unit, recorded_at, battery_level, measurement_condition } = req.body || {};
  const markError = (message) => { db.prepare('UPDATE devices SET status = ?, sync_error = ? WHERE id = ? AND user_id = ?').run('error', String(message).slice(0, 240), id, req.user.id); };
  const def = type ? db.prepare('SELECT type, unit, value_type, min_value, max_value FROM metric_defs WHERE type = ?').get(type) : null;
  const numeric = Number(value);
  if (!def || !Number.isFinite(numeric)) { markError('unsupported metric or invalid value'); return res.status(400).json({ error: 'unsupported metric or invalid value' }); }
  if (def.min_value != null && numeric < def.min_value || def.max_value != null && numeric > def.max_value) { markError('value outside physical range'); return res.status(400).json({ error: 'value outside physical range' }); }
  const at = recorded_at && !Number.isNaN(Date.parse(recorded_at)) ? new Date(recorded_at).toISOString() : new Date().toISOString();
  if (def.value_type === 'dual' && (!Number.isFinite(Number(value2)) || Number(value2) < 30 || Number(value2) > 180)) { markError('invalid secondary metric value'); return res.status(400).json({ error: 'invalid secondary metric value' }); }
  const duplicate = db.prepare(`SELECT id FROM metrics WHERE user_id = ? AND type = ? AND value = ? AND COALESCE(value2, -999999) = COALESCE(?, -999999) AND abs(julianday(recorded_at) - julianday(?)) < (60.0 / 86400.0) LIMIT 1`).get(req.user.id, type, numeric, value2 == null ? null : Number(value2), at);
  if (duplicate) return res.status(200).json({ device, metric: db.prepare('SELECT * FROM metrics WHERE id = ?').get(duplicate.id), duplicate: true });
  const quality = { valid: true, duplicate: false, flags: [], source: 'device', device_id: id, condition_present: Boolean(measurement_condition) };
  const inserted = db.prepare('INSERT INTO metrics (user_id, type, value, value2, unit, recorded_at, source, device_id, measurement_condition, data_quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, type, numeric, value2 == null ? null : Number(value2), unit || def.unit, at, 'device', id, measurement_condition || null, JSON.stringify(quality));
  const battery = battery_level == null ? device.battery_level : Number(battery_level);
  db.prepare('UPDATE devices SET status = ?, last_sync = ?, battery_level = ?, sync_error = NULL WHERE id = ? AND user_id = ?')
    .run('connected', new Date().toISOString(), Number.isFinite(battery) ? Math.max(0, Math.min(100, battery)) : device.battery_level, id, req.user.id);
  res.status(201).json({ device: db.prepare('SELECT * FROM devices WHERE id = ?').get(id), metric: db.prepare('SELECT * FROM metrics WHERE id = ?').get(inserted.lastInsertRowid), quality });
});

export default router;
