import express from 'express';
import db from '../db.js';
import { evaluateHealth } from '../lib/scoring.js';

const router = express.Router();

// ============= 评估 =============
router.get('/assessments/latest', (req, res) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const metrics = db.prepare(`
    SELECT * FROM metrics
    WHERE user_id = ? AND recorded_at >= ?
    ORDER BY recorded_at DESC
  `).all(req.user.id, sevenDaysAgo);

  const todayDate = new Date().toISOString().slice(0, 10);
  const todos = db.prepare(`
    SELECT * FROM todos WHERE user_id = ? AND date = ?
  `).all(req.user.id, todayDate);
  const todoCompletionRate = todos.length
    ? todos.filter(t => t.completed).length / todos.length
    : 0;

  const evaluation = evaluateHealth(metrics, { todoCompletionRate, height: req.user.height });

  // ADL / IADL：优先读取统一健康档案问卷，旧 assessments 记录仅作兼容回退。
  const latestIntake = db.prepare(`
    SELECT scores, recorded_at FROM health_intakes
    WHERE subject_user_id = ? AND status = 'completed'
    ORDER BY recorded_at DESC, id DESC LIMIT 1
  `).get(req.user.id);
  let intakeScores = {};
  try { intakeScores = latestIntake ? JSON.parse(latestIntake.scores || '{}') : {}; } catch { intakeScores = {}; }
  const lastAssess = db.prepare(`
    SELECT adl, iadl FROM assessments WHERE user_id = ? ORDER BY id DESC LIMIT 1
  `).get(req.user.id);
  const adl = Number.isFinite(Number(intakeScores.adlab_c)) ? Number(intakeScores.adlab_c) : (lastAssess?.adl ?? null);
  const iadl = Number.isFinite(Number(intakeScores.iadl)) ? Number(intakeScores.iadl) : (lastAssess?.iadl ?? null);

  res.json({
    total_score: evaluation.total_score,
    subscores: evaluation.subscores,
    scoring_details: evaluation.scoring_details,
    adl,
    iadl,
    functional_evaluated_at: latestIntake?.recorded_at ?? null,
    functional_complete: adl != null && iadl != null,
    suggestions: evaluation.suggestions,
    summary: evaluation.summary,
    evaluated_at: new Date().toISOString(),
  });
});

router.post('/assessments', (req, res) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const metrics = db.prepare(`
    SELECT * FROM metrics WHERE user_id = ? AND recorded_at >= ?
  `).all(req.user.id, sevenDaysAgo);

  const ev = evaluateHealth(metrics, { height: req.user.height });
  const lastAssess = db.prepare(`
    SELECT adl, iadl FROM assessments WHERE user_id = ? ORDER BY id DESC LIMIT 1
  `).get(req.user.id);

  const r = db.prepare(`
    INSERT INTO assessments (user_id, total_score, subscores, adl, iadl, suggestions, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    ev.total_score,
    JSON.stringify(ev.subscores),
    lastAssess?.adl ?? null,
    lastAssess?.iadl ?? null,
    JSON.stringify(ev.suggestions),
    ev.summary
  );
  res.json(db.prepare('SELECT * FROM assessments WHERE id = ?').get(r.lastInsertRowid));
});

router.get('/assessments', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM assessments WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 30
  `).all(req.user.id);
  res.json(rows);
});

export default router;
