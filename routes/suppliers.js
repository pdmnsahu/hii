const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
  res.json(suppliers);
});

router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  const { name, contact, address, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Supplier name is required' });
  const result = db.prepare('INSERT INTO suppliers (name, contact, address, email) VALUES (?, ?, ?, ?)').run(name, contact || null, address || null, email || null);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { name, contact, address, email } = req.body;
  db.prepare('UPDATE suppliers SET name=?, contact=?, address=?, email=? WHERE id=?').run(name, contact || null, address || null, email || null, req.params.id);
  res.json({ success: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
