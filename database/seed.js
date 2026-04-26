// database/seed.js — creates default admin user (idempotent)
const bcrypt = require('bcryptjs');
const { getDb, initializeDatabase } = require('./db');

function seed() {
  initializeDatabase();
  const db = getDb();

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO users (username, password, full_name, role)
      VALUES (?, ?, ?, ?)
    `).run('admin', hash, 'Administrator', 'admin');
    console.log('✅ Default admin user created (admin / admin123)');
  } else {
    console.log('ℹ️  Admin user already exists, skipping seed');
  }
}

seed();
