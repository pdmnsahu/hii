const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireGuest, requireAuth } = require('../middleware/auth');

router.get('/login', requireGuest, (req, res) => {
  res.sendFile('login.html', { root: './public/pages' });
});

router.post('/api/login', requireGuest, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.fullName = user.full_name;
  res.json({ success: true, redirect: '/' });
});

router.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

router.get('/api/me', requireAuth, (req, res) => {
  res.json({
    userId: req.session.userId,
    username: req.session.username,
    fullName: req.session.fullName
  });
});

module.exports = router;
