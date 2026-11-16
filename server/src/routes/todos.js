import express from 'express';
import db from '../db.js';

const router = express.Router();

// ============= 待办 =============
router.get('/todos/today', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todos = db.prepare(`
    SELECT * FROM todos WHERE user_id = ? AND date = ? ORDER BY time ASC
  `).all(req.user.id, today);
  res.json(todos);
});

router.patch('/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { completed } = req.body;
  const completed_at = completed ? new Date().toISOString() : null;
  db.prepare(`
    UPDATE todos SET completed = ?, completed_at = ? WHERE id = ? AND user_id = ?
  `).run(completed ? 1 : 0, completed_at, id, req.user.id);
  res.json(db.prepare('SELECT * FROM todos WHERE id = ?').get(id));
});

router.post('/todos', (req, res) => {
  const { title, time, kind, date } = req.body;
  if (!title || !time) return res.status(400).json({ error: 'title and time required' });
  const r = db.prepare(`
    INSERT INTO todos (user_id, title, time, kind, date) VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, title, time, kind || 'todo', date || new Date().toISOString().slice(0, 10));
  res.json(db.prepare('SELECT * FROM todos WHERE id = ?').get(r.lastInsertRowid));
});

router.delete('/todos/:id', (req, res) => {
  db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').run(parseInt(req.params.id, 10), req.user.id);
  res.json({ ok: true });
});

export default router;
