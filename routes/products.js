// routes/products.js — product catalogue (master data only)
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

// ── GET all products with aggregated stock from batches ──────────────────────
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { search, category, status } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const nearDate = new Date();
  nearDate.setDate(nearDate.getDate() + 30);
  const nearStr = nearDate.toISOString().split('T')[0];

  // Aggregate available stock and earliest expiry from active (non-expired) batches
  let query = `
    SELECT
      p.*,
      COALESCE(SUM(CASE WHEN b.expiry_date IS NULL OR b.expiry_date >= ? THEN b.quantity_available ELSE 0 END), 0) AS total_stock,
      MIN(CASE WHEN b.quantity_available > 0 AND (b.expiry_date IS NULL OR b.expiry_date >= ?) THEN b.expiry_date END) AS nearest_expiry,
      COUNT(DISTINCT b.id) AS batch_count
    FROM products p
    LEFT JOIN product_batches b ON b.product_id = p.id
    WHERE 1=1
  `;
  const params = [today, today];

  if (search) {
    query += ` AND (p.name LIKE ? OR p.brand LIKE ? OR p.generic_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (category) {
    query += ` AND p.category = ?`;
    params.push(category);
  }

  query += ` GROUP BY p.id ORDER BY p.name ASC`;

  let products = db.prepare(query).all(...params);

  // Compute stock_status on each row
  products = products.map(p => {
    let stock_status;
    if (p.nearest_expiry && p.nearest_expiry < today) {
      stock_status = 'expired';
    } else if (p.nearest_expiry && p.nearest_expiry <= nearStr && p.total_stock > 0) {
      stock_status = 'near_expiry';
    } else if (p.total_stock === 0) {
      stock_status = 'out_of_stock';
    } else if (p.total_stock <= p.min_stock_level) {
      stock_status = 'low_stock';
    } else {
      stock_status = 'in_stock';
    }
    return { ...p, stock_status };
  });

  // Apply status filter post-aggregation (simpler than complex SQL subquery)
  if (status && status !== '') {
    if (status === 'near_expiry') {
      products = products.filter(p => p.stock_status === 'near_expiry');
    } else if (status === 'expired') {
      products = products.filter(p => {
        // product has at least one expired batch with stock
        const expiredBatches = db.prepare(`
          SELECT COUNT(*) as c FROM product_batches
          WHERE product_id=? AND expiry_date < ? AND quantity_available > 0
        `).get(p.id, today);
        return expiredBatches.c > 0;
      });
    } else {
      products = products.filter(p => p.stock_status === status);
    }
  }

  res.json(products);
});

// ── GET single product with its batches ─────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const today = new Date().toISOString().split('T')[0];
  const batches = db.prepare(`
    SELECT b.*, s.name as supplier_name
    FROM product_batches b
    LEFT JOIN suppliers s ON b.supplier_id = s.id
    WHERE b.product_id = ?
    ORDER BY b.expiry_date ASC, b.created_at ASC
  `).all(req.params.id);

  const total_stock = batches
    .filter(b => !b.expiry_date || b.expiry_date >= today)
    .reduce((s, b) => s + b.quantity_available, 0);

  res.json({ ...product, batches, total_stock });
});

// ── POST create product (master data, no initial stock) ──────────────────────
router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  const { name, generic_name, brand, category, dosage_form, unit, selling_price, min_stock_level, description } = req.body;

  if (!name) return res.status(400).json({ error: 'Product name is required' });
  if (selling_price == null || isNaN(parseFloat(selling_price))) {
    return res.status(400).json({ error: 'Selling price is required' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO products (name, generic_name, brand, category, dosage_form, unit, selling_price, min_stock_level, description, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      name.trim(),
      generic_name?.trim() || null,
      brand?.trim() || null,
      category || null,
      dosage_form?.trim() || null,
      unit || 'tablet',
      parseFloat(selling_price),
      parseInt(min_stock_level) || 10,
      description?.trim() || null
    );
    res.json({ success: true, id: result.lastInsertRowid, message: 'Product added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT update product master data ───────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { name, generic_name, brand, category, dosage_form, unit, selling_price, min_stock_level, description } = req.body;

  if (!name) return res.status(400).json({ error: 'Product name is required' });
  if (selling_price == null || isNaN(parseFloat(selling_price))) {
    return res.status(400).json({ error: 'Selling price is required' });
  }

  try {
    db.prepare(`
      UPDATE products
      SET name=?, generic_name=?, brand=?, category=?, dosage_form=?, unit=?,
          selling_price=?, min_stock_level=?, description=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      name.trim(),
      generic_name?.trim() || null,
      brand?.trim() || null,
      category || null,
      dosage_form?.trim() || null,
      unit || 'tablet',
      parseFloat(selling_price),
      parseInt(min_stock_level) || 10,
      description?.trim() || null,
      req.params.id
    );
    res.json({ success: true, message: 'Product updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE product ───────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  try {
    // Check for active (non-zero) stock
    const activeStock = db.prepare(`
      SELECT COALESCE(SUM(quantity_available),0) as total
      FROM product_batches WHERE product_id=?
    `).get(req.params.id);

    if (activeStock.total > 0) {
      return res.status(400).json({
        error: `Cannot delete: product has ${activeStock.total} units in stock. Deplete or adjust batches first.`
      });
    }

    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET categories ────────────────────────────────────────────────────────────
router.get('/meta/categories', requireAuth, (req, res) => {
  const db = getDb();
  const categories = db.prepare(
    'SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category'
  ).all();
  res.json(categories.map(c => c.category));
});

// ── GET batches for a product (for recall / traceability search) ─────────────
router.get('/:id/batches', requireAuth, (req, res) => {
  const db = getDb();
  const batches = db.prepare(`
    SELECT b.*, s.name as supplier_name,
           pi.purchase_id,
           pu.invoice_number,
           pu.purchase_date
    FROM product_batches b
    LEFT JOIN suppliers s      ON b.supplier_id      = s.id
    LEFT JOIN purchase_items pi ON b.purchase_item_id = pi.id
    LEFT JOIN purchases pu      ON pi.purchase_id      = pu.id
    WHERE b.product_id = ?
    ORDER BY b.expiry_date ASC, b.created_at ASC
  `).all(req.params.id);
  res.json(batches);
});

// ── GET batch search (recall traceability) ───────────────────────────────────
router.get('/meta/batch-search', requireAuth, (req, res) => {
  const db = getDb();
  const { q } = req.query;
  if (!q) return res.json([]);

  const results = db.prepare(`
    SELECT b.*, p.name as product_name, p.category,
           s.name as supplier_name,
           pi.purchase_id,
           pu.invoice_number, pu.purchase_date
    FROM product_batches b
    JOIN products p            ON b.product_id        = p.id
    LEFT JOIN suppliers s      ON b.supplier_id        = s.id
    LEFT JOIN purchase_items pi ON b.purchase_item_id  = pi.id
    LEFT JOIN purchases pu      ON pi.purchase_id       = pu.id
    WHERE b.batch_number LIKE ?
    ORDER BY p.name, b.expiry_date
  `).all(`%${q}%`);

  res.json(results);
});

module.exports = router;
