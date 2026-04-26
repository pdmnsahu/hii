const express = require('express');
const session = require('express-session');
const path = require('path');
const { initializeDatabase } = require('./database/db');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

initializeDatabase();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'pharma-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Auth routes
app.use('/', require('./routes/auth'));

// Protected API routes
app.use('/api/products',   require('./routes/products'));
app.use('/api/suppliers',  require('./routes/suppliers'));
app.use('/api/purchases',  require('./routes/purchases'));
app.use('/api/sales',      require('./routes/sales'));
app.use('/api/dashboard',  require('./routes/dashboard'));

// Main SPA
app.get('/', requireAuth, (req, res) => res.sendFile('index.html', { root: './public' }));
app.get('/app/*path', requireAuth, (req, res) => res.sendFile('index.html', { root: './public' }));

app.listen(PORT, () => {
  console.log(`\n🏥 MediStore running at http://localhost:${PORT}`);
  console.log(`   Login: admin / admin123\n`);
});
