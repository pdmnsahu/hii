// routes/purchases.js — every purchase creates batch-level stock records
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

// ── GET all purchases ────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { from, to, supplier_id } = req.query;

  let query = `
    SELECT p.*, s.name as supplier_name_rel,
           COUNT(pi.id) as item_count
    FROM purchases p
    LEFT JOIN suppliers s      ON p.supplier_id = s.id
    LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (from) { query += ` AND p.purchase_date >= ?`; params.push(from); }
  if (to)   { query += ` AND p.purchase_date <= ?`; params.push(to); }
  if (supplier_id) { query += ` AND p.supplier_id = ?`; params.push(supplier_id); }

  query += ` GROUP BY p.id ORDER BY p.purchase_date DESC, p.created_at DESC`;
  res.json(db.prepare(query).all(...params));
});

// ── GET single purchase with items ───────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

  const items = db.prepare(`
    SELECT pi.*, b.id as batch_id
    FROM purchase_items pi
    LEFT JOIN product_batches b ON b.purchase_item_id = pi.id
    WHERE pi.purchase_id = ?
  `).all(req.params.id);

  res.json({ ...purchase, items });
});

// ── POST create purchase ─────────────────────────────────────────────────────
// Each item in the purchase requires: product_id, batch_number, expiry_date,
// quantity, unit_price.  Each item creates one product_batches row.
router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  const { supplier_id, supplier_name, invoice_number, purchase_date, items, notes } = req.body;

  if (!purchase_date) return res.status(400).json({ error: 'Purchase date is required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

  // Validate all items before touching the DB
  for (const item of items) {
    if (!item.product_id)   return res.status(400).json({ error: 'Each item needs a product' });
    if (!item.batch_number?.trim()) return res.status(400).json({ error: 'Each item needs a batch number' });
    if (!item.quantity || parseInt(item.quantity) < 1)
      return res.status(400).json({ error: 'Quantity must be ≥ 1' });
    if (item.unit_price == null || parseFloat(item.unit_price) < 0)
      return res.status(400).json({ error: 'Unit price must be ≥ 0' });
  }

  const doInsert = db.transaction(() => {
    // Resolve supplier name
    let supName = supplier_name || null;
    if (supplier_id) {
      const sup = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(supplier_id);
      if (sup) supName = sup.name;
    }

    const pResult = db.prepare(`
      INSERT INTO purchases (supplier_id, supplier_name, invoice_number, purchase_date, total_amount, notes)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(supplier_id || null, supName || 'Unknown', invoice_number || null, purchase_date, notes || null);

    const purchaseId = pResult.lastInsertRowid;
    let total = 0;

    for (const item of items) {
      const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);

      const qty       = parseInt(item.quantity);
      const unitPrice = parseFloat(item.unit_price);
      const lineTotal = qty * unitPrice;
      total += lineTotal;

      // Insert purchase item row (now includes batch_number + expiry_date)
      const piResult = db.prepare(`
        INSERT INTO purchase_items
          (purchase_id, product_id, product_name, batch_number, expiry_date, quantity, unit_price, total_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        purchaseId, product.id, product.name,
        item.batch_number.trim(),
        item.expiry_date || null,
        qty, unitPrice, lineTotal
      );

      // Create a product_batches row for this receipt.
      // We do NOT merge with existing same-batch rows — each purchase creates
      // its own batch record for full traceability.  This lets you see exactly
      // which invoice delivered which units.
      db.prepare(`
        INSERT INTO product_batches
          (product_id, batch_number, expiry_date, purchase_price,
           quantity_received, quantity_available,
           supplier_id, purchase_item_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        product.id,
        item.batch_number.trim(),
        item.expiry_date || null,
        unitPrice,
        qty, qty,
        supplier_id || null,
        piResult.lastInsertRowid
      );
    }

    db.prepare('UPDATE purchases SET total_amount = ? WHERE id = ?').run(total, purchaseId);
    return purchaseId;
  });

  try {
    const id = doInsert();
    res.json({ success: true, id, message: 'Purchase recorded successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE purchase — reverse the batch stock ─────────────────────────────────
// Batches whose quantity_available still equals quantity_received can be fully
// deleted.  Batches partially consumed by sales are only partially reduced.
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();

  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

  const doDelete = db.transaction(() => {
    const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(req.params.id);

    for (const item of items) {
      // Find the batch(es) created by this purchase item
      const batches = db.prepare(`
        SELECT * FROM product_batches WHERE purchase_item_id = ?
      `).all(item.id);

      for (const batch of batches) {
        const soldFromBatch = batch.quantity_received - batch.quantity_available;
        if (soldFromBatch > 0) {
          // Some units already sold — can only reduce the unsold portion
          db.prepare(`
            UPDATE product_batches
            SET quantity_available = 0, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(batch.id);
        } else {
          // No units sold — remove the batch entirely
          db.prepare('DELETE FROM product_batches WHERE id = ?').run(batch.id);
        }
      }
    }

    db.prepare('DELETE FROM purchases WHERE id = ?').run(req.params.id);
  });

  try {
    doDelete();
    res.json({ success: true, message: 'Purchase deleted and stock reversed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
