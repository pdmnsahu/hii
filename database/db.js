const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'pharmacy.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initializeDatabase() {
  const db = getDb();

  db.exec(`
    -- ── Users ──────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      full_name   TEXT,
      role        TEXT DEFAULT 'admin',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Suppliers ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS suppliers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      contact     TEXT,
      address     TEXT,
      email       TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Products (master/catalogue data only, NO batch or stock fields) ────────
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

    -- ── Product Batches (one row = one stock batch for one product) ────────────
    -- Each manufacturer lot is a separate batch.  Multiple suppliers can deliver
    -- from the same manufacturer batch_number; we keep them as separate rows so
    -- purchase traceability is preserved.
    CREATE TABLE IF NOT EXISTS product_batches (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id         INTEGER NOT NULL,
      batch_number       TEXT NOT NULL,
      expiry_date        DATE,
      purchase_price     REAL NOT NULL DEFAULT 0,
      quantity_received  INTEGER NOT NULL DEFAULT 0,
      quantity_available INTEGER NOT NULL DEFAULT 0,
      supplier_id        INTEGER,
      purchase_item_id   INTEGER,  -- back-link to the purchase_items row
      manufactured_at    DATE,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id)       REFERENCES products(id),
      FOREIGN KEY (supplier_id)      REFERENCES suppliers(id),
      FOREIGN KEY (purchase_item_id) REFERENCES purchase_items(id)
    );

    CREATE INDEX IF NOT EXISTS idx_batches_product   ON product_batches(product_id);
    CREATE INDEX IF NOT EXISTS idx_batches_expiry    ON product_batches(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_batches_batch_num ON product_batches(batch_number);

    -- ── Purchases (header) ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS purchases (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id     INTEGER,
      supplier_name   TEXT,
      invoice_number  TEXT,
      purchase_date   DATE NOT NULL,
      total_amount    REAL DEFAULT 0,
      notes           TEXT,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    -- ── Purchase Items ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS purchase_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id   INTEGER NOT NULL,
      product_id    INTEGER NOT NULL,
      product_name  TEXT NOT NULL,
      batch_number  TEXT NOT NULL,
      expiry_date   DATE,
      quantity      INTEGER NOT NULL,
      unit_price    REAL NOT NULL,
      total_price   REAL NOT NULL,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id)  REFERENCES products(id)
    );

    -- ── Sales (header) ─────────────────────────────────────────────────────────
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

    -- ── Sale Items ─────────────────────────────────────────────────────────────
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

    -- ── Sale Item → Batch Allocations (FEFO consumption trail) ────────────────
    -- Records exactly which batches were deducted for each sale line.
    CREATE TABLE IF NOT EXISTS sale_item_batch_allocations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_item_id     INTEGER NOT NULL,
      product_batch_id INTEGER NOT NULL,
      quantity         INTEGER NOT NULL,
      unit_cost        REAL NOT NULL,   -- purchase_price of that batch
      unit_price       REAL NOT NULL,   -- selling price charged
      line_profit      REAL NOT NULL,
      FOREIGN KEY (sale_item_id)     REFERENCES sale_items(id)        ON DELETE CASCADE,
      FOREIGN KEY (product_batch_id) REFERENCES product_batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_siba_sale_item ON sale_item_batch_allocations(sale_item_id);
    CREATE INDEX IF NOT EXISTS idx_siba_batch     ON sale_item_batch_allocations(product_batch_id);
  `);

  console.log('✅ Database schema ready');
  return db;
}

module.exports = { getDb, initializeDatabase };
