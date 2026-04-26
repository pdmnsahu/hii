// routes/sales.js — FEFO batch allocation on every sale
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

// ── GET all sales ────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  let query = `
    SELECT s.*, COUNT(si.id) as item_count
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE 1=1
  `;
  const params = [];
  if (from) { query += ` AND s.sale_date >= ?`; params.push(from); }
  if (to)   { query += ` AND s.sale_date <= ?`; params.push(to); }
  query += ` GROUP BY s.id ORDER BY s.sale_date DESC, s.created_at DESC`;
  res.json(db.prepare(query).all(...params));
});

// ── GET single sale with items + batch allocations ───────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id);

  // Attach batch allocations to each item for receipt/audit display
  for (const item of items) {
    item.batch_allocations = db.prepare(`
      SELECT a.*, b.batch_number, b.expiry_date
      FROM sale_item_batch_allocations a
      JOIN product_batches b ON a.product_batch_id = b.id
      WHERE a.sale_item_id = ?
      ORDER BY b.expiry_date ASC
    `).all(item.id);
  }

  res.json({ ...sale, items });
});

// ── POST create sale (FEFO allocation) ───────────────────────────────────────
//
// FEFO = First Expiry, First Out.
// For each sale item we pick batches ordered by expiry_date ASC (nulls last),
// then created_at ASC (oldest receipt first if same expiry).
// Expired batches (expiry_date < today) are skipped — cannot be sold.
//
router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  const { sale_date, items, customer_name, notes } = req.body;

  if (!sale_date) return res.status(400).json({ error: 'Sale date is required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

  const today = new Date().toISOString().split('T')[0];

  // ── Pre-flight stock validation (outside transaction for readable errors) ──
  for (const item of items) {
    if (!item.product_id) return res.status(400).json({ error: 'Each item needs a product' });
    const qty = parseInt(item.quantity);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Quantity must be ≥ 1' });

    const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(item.product_id);
    if (!product) return res.status(400).json({ error: `Product ${item.product_id} not found` });

    // Available = sum across non-expired batches
    const avail = db.prepare(`
      SELECT COALESCE(SUM(quantity_available), 0) as total
      FROM product_batches
      WHERE product_id = ?
        AND quantity_available > 0
        AND (expiry_date IS NULL OR expiry_date >= ?)
    `).get(item.product_id, today);

    if (avail.total < qty) {
      return res.status(400).json({
        error: `Insufficient non-expired stock for "${product.name}". Available: ${avail.total}, Requested: ${qty}`
      });
    }
  }

  const doSale = db.transaction(() => {
    const sResult = db.prepare(`
      INSERT INTO sales (sale_date, total_amount, total_cost, profit, customer_name, notes)
      VALUES (?, 0, 0, 0, ?, ?)
    `).run(sale_date, customer_name || null, notes || null);

    const saleId = sResult.lastInsertRowid;
    let totalAmount = 0, totalCost = 0;

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      let remaining = parseInt(item.quantity);
      const unitPrice = parseFloat(item.unit_price) || product.selling_price;

      // Fetch batches in FEFO order: earliest expiry first, then oldest receipt
      // Null expiry treated as "never expires" — comes last
      const batches = db.prepare(`
        SELECT * FROM product_batches
        WHERE product_id = ?
          AND quantity_available > 0
          AND (expiry_date IS NULL OR expiry_date >= ?)
        ORDER BY
          CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END ASC,
          expiry_date ASC,
          created_at ASC
      `).all(item.product_id, today);

      let itemCost = 0;
      const allocations = [];

      for (const batch of batches) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, batch.quantity_available);
        const lineCost   = take * batch.purchase_price;
        const lineRevenue = take * unitPrice;
        const lineProfit  = lineRevenue - lineCost;

        allocations.push({
          batch_id:   batch.id,
          quantity:   take,
          unit_cost:  batch.purchase_price,
          unit_price: unitPrice,
          line_profit: lineProfit
        });

        // Deduct stock immediately so next item in this sale doesn't double-dip
        db.prepare(`
          UPDATE product_batches
          SET quantity_available = quantity_available - ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(take, batch.id);

        itemCost  += lineCost;
        remaining -= take;
      }

      if (remaining > 0) {
        // Shouldn't reach here after pre-flight, but guard anyway
        throw new Error(`Stock ran out mid-transaction for "${product.name}"`);
      }

      const itemTotal  = parseInt(item.quantity) * unitPrice;
      const itemProfit = itemTotal - itemCost;

      const siResult = db.prepare(`
        INSERT INTO sale_items
          (sale_id, product_id, product_name, quantity, unit_price, total_price, total_cost, profit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(saleId, product.id, product.name,
             parseInt(item.quantity), unitPrice, itemTotal, itemCost, itemProfit);

      // Record each batch allocation
      for (const a of allocations) {
        db.prepare(`
          INSERT INTO sale_item_batch_allocations
            (sale_item_id, product_batch_id, quantity, unit_cost, unit_price, line_profit)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(siResult.lastInsertRowid, a.batch_id, a.quantity, a.unit_cost, a.unit_price, a.line_profit);
      }

      totalAmount += itemTotal;
      totalCost   += itemCost;
    }

    db.prepare(`
      UPDATE sales SET total_amount=?, total_cost=?, profit=? WHERE id=?
    `).run(totalAmount, totalCost, totalAmount - totalCost, saleId);

    return saleId;
  });

  try {
    const id = doSale();
    res.json({ success: true, id, message: 'Sale recorded successfully' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── DELETE sale — restore batch stock from allocation records ─────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });

  const doDelete = db.transaction(() => {
    // Use the allocation trail to restore exactly the right batch quantities
    const allocations = db.prepare(`
      SELECT a.* FROM sale_item_batch_allocations a
      JOIN sale_items si ON a.sale_item_id = si.id
      WHERE si.sale_id = ?
    `).all(req.params.id);

    for (const a of allocations) {
      db.prepare(`
        UPDATE product_batches
        SET quantity_available = quantity_available + ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(a.quantity, a.product_batch_id);
    }

    db.prepare('DELETE FROM sales WHERE id = ?').run(req.params.id);
  });

  try {
    doDelete();
    res.json({ success: true, message: 'Sale deleted and batch stock restored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
