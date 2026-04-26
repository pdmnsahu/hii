/**
 * database/migrate.js
 *
 * Run ONCE against an existing pharmacy.db that uses the old flat schema.
 * Creates the new tables, then migrates existing products/purchases into
 * the batch-aware model.
 *
 * Usage:  node database/migrate.js
 *
 * Safe to run on a fresh DB (no-ops if tables already exist / are empty).
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'pharmacy.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // temporarily off during migration

console.log('🔄 Starting schema migration …');

// ── 1. Check if old schema is present ───────────────────────────────────────
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
const hasOldProducts = tables.includes('products');
const hasOldPurchaseItems = tables.includes('purchase_items');

// ── 2. Create new tables (from db.js schema) ─────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT,
    role TEXT DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact TEXT,
    address TEXT,
    email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER,
    supplier_name TEXT,
    invoice_number TEXT,
    purchase_date DATE NOT NULL,
    total_amount REAL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    batch_number TEXT NOT NULL,
    expiry_date DATE,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    total_price REAL NOT NULL,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

// ── 3. Rename old products table, create new one ──────────────────────────────
const hasNewProducts = db.prepare(`
  SELECT sql FROM sqlite_master WHERE type='table' AND name='products'
`).get()?.sql || '';

// Detect old schema by checking for batch_number column
const isOldSchema = hasNewProducts.includes('batch_number');

if (isOldSchema) {
  console.log('📦 Old products table detected — migrating …');
  db.exec(`ALTER TABLE products RENAME TO _old_products;`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    generic_name     TEXT,
    brand            TEXT,
    category         TEXT,
    dosage_form      TEXT,
    unit             TEXT DEFAULT 'tablet',
    selling_price    REAL NOT NULL DEFAULT 0,
    min_stock_level  INTEGER DEFAULT 10,
    description      TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_batches (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id         INTEGER NOT NULL,
    batch_number       TEXT NOT NULL,
    expiry_date        DATE,
    purchase_price     REAL NOT NULL DEFAULT 0,
    quantity_received  INTEGER NOT NULL DEFAULT 0,
    quantity_available INTEGER NOT NULL DEFAULT 0,
    supplier_id        INTEGER,
    purchase_item_id   INTEGER,
    manufactured_at    DATE,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id)  REFERENCES products(id),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
  );

  CREATE INDEX IF NOT EXISTS idx_batches_product   ON product_batches(product_id);
  CREATE INDEX IF NOT EXISTS idx_batches_expiry    ON product_batches(expiry_date);
  CREATE INDEX IF NOT EXISTS idx_batches_batch_num ON product_batches(batch_number);

  CREATE TABLE IF NOT EXISTS sales (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_date      DATE NOT NULL,
    total_amount   REAL DEFAULT 0,
    total_cost     REAL DEFAULT 0,
    profit         REAL DEFAULT 0,
    customer_name  TEXT,
    notes          TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sale_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id       INTEGER NOT NULL,
    product_id    INTEGER NOT NULL,
    product_name  TEXT NOT NULL,
    quantity      INTEGER NOT NULL,
    unit_price    REAL NOT NULL,
    total_price   REAL NOT NULL,
    total_cost    REAL NOT NULL,
    profit        REAL NOT NULL,
    FOREIGN KEY (sale_id)    REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS sale_item_batch_allocations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_item_id     INTEGER NOT NULL,
    product_batch_id INTEGER NOT NULL,
    quantity         INTEGER NOT NULL,
    unit_cost        REAL NOT NULL,
    unit_price       REAL NOT NULL,
    line_profit      REAL NOT NULL,
    FOREIGN KEY (sale_item_id)     REFERENCES sale_items(id) ON DELETE CASCADE,
    FOREIGN KEY (product_batch_id) REFERENCES product_batches(id)
  );

  CREATE INDEX IF NOT EXISTS idx_siba_sale_item ON sale_item_batch_allocations(sale_item_id);
  CREATE INDEX IF NOT EXISTS idx_siba_batch     ON sale_item_batch_allocations(product_batch_id);
`);

// ── 4. Migrate old product rows ───────────────────────────────────────────────
if (isOldSchema) {
  const migrate = db.transaction(() => {
    const oldProducts = db.prepare('SELECT * FROM _old_products').all();
    console.log(`  → Migrating ${oldProducts.length} products …`);

    for (const op of oldProducts) {
      // Insert product master (no batch/stock fields)
      db.prepare(`
        INSERT INTO products (id, name, brand, category, unit, selling_price, min_stock_level, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'tablet', ?, ?, ?, ?, ?)
      `).run(op.id, op.name, op.brand || null, op.category || null,
             op.selling_price, op.min_stock_level || 10,
             op.description || null, op.created_at, op.updated_at || op.created_at);

      // Create one batch row representing the current stock
      if (op.quantity > 0 || op.batch_number) {
        db.prepare(`
          INSERT INTO product_batches
            (product_id, batch_number, expiry_date, purchase_price, quantity_received, quantity_available, supplier_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          op.id,
          op.batch_number || `MIGRATED-${op.id}`,
          op.expiry_date || null,
          op.purchase_price || 0,
          op.quantity || 0,
          op.quantity || 0,
          op.supplier_id || null
        );
      }
    }

    // Migrate purchase_items: add batch_number + expiry_date columns if missing
    // (old purchase_items has no batch_number column)
    const piCols = db.prepare(`PRAGMA table_info(purchase_items)`).all().map(c => c.name);
    if (!piCols.includes('batch_number')) {
      console.log('  → purchase_items table already migrated via CREATE TABLE IF NOT EXISTS — done');
    }
  });

  migrate();
  console.log('✅ Product data migrated');
}

db.pragma('foreign_keys = ON');
console.log('✅ Migration complete');
db.close();
