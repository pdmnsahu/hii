// routes/dashboard.js — stats, trends, reports all batch-aware
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

// ── Dashboard stats ──────────────────────────────────────────────────────────
router.get('/stats', requireAuth, (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const nearDate = new Date(); nearDate.setDate(nearDate.getDate() + 30);
  const nearStr = nearDate.toISOString().split('T')[0];

  const monthStart = new Date(); monthStart.setDate(1);
  const monthStartStr = monthStart.toISOString().split('T')[0];
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekStartStr = weekStart.toISOString().split('T')[0];

  // Total distinct products
  const totalProducts = db.prepare('SELECT COUNT(*) as c FROM products').get().c;

  // Stock aggregated from batches (non-expired only)
  const totalStock = db.prepare(`
    SELECT COALESCE(SUM(quantity_available),0) as total
    FROM product_batches
    WHERE expiry_date IS NULL OR expiry_date >= ?
  `).get(today).total;

  // Products with total available stock <= min_stock_level (aggregate per product)
  const lowStock = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT p.id
      FROM products p
      LEFT JOIN product_batches b
        ON b.product_id = p.id
        AND (b.expiry_date IS NULL OR b.expiry_date >= ?)
      GROUP BY p.id
      HAVING COALESCE(SUM(b.quantity_available),0) > 0
         AND COALESCE(SUM(b.quantity_available),0) <= p.min_stock_level
    )
  `).get(today).c;

  const outOfStock = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT p.id
      FROM products p
      LEFT JOIN product_batches b
        ON b.product_id = p.id
        AND (b.expiry_date IS NULL OR b.expiry_date >= ?)
      GROUP BY p.id
      HAVING COALESCE(SUM(b.quantity_available),0) = 0
    )
  `).get(today).c;

  // Distinct products that have at least one near-expiry batch with stock
  const nearExpiry = db.prepare(`
    SELECT COUNT(DISTINCT product_id) as c FROM product_batches
    WHERE expiry_date >= ? AND expiry_date <= ? AND quantity_available > 0
  `).get(today, nearStr).c;

  // Distinct products with at least one expired batch still holding stock
  const expired = db.prepare(`
    SELECT COUNT(DISTINCT product_id) as c FROM product_batches
    WHERE expiry_date < ? AND quantity_available > 0
  `).get(today).c;

  // Sales stats
  const salesQ = (dateFilter) => db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) as total,
           COALESCE(SUM(profit),0) as profit,
           COUNT(*) as count
    FROM sales WHERE ${dateFilter}
  `);

  const todaySales  = salesQ('sale_date = ?').get(today);
  const weekSales   = salesQ('sale_date >= ?').get(weekStartStr);
  const monthSales  = salesQ('sale_date >= ?').get(monthStartStr);

  // Stock valuation from batches (purchase_price × quantity_available)
  const stockValuation = db.prepare(`
    SELECT COALESCE(SUM(purchase_price * quantity_available),0) as value
    FROM product_batches
    WHERE expiry_date IS NULL OR expiry_date >= ?
  `).get(today).value;

  // Recent sales
  const recentSales = db.prepare(`
    SELECT * FROM sales ORDER BY created_at DESC LIMIT 10
  `).all();

  // Recent purchases
  const recentPurchases = db.prepare(`
    SELECT * FROM purchases ORDER BY created_at DESC LIMIT 5
  `).all();

  // Top selling products (last 30 days) — profit from real batch cost
  const thirtyAgo = new Date(); thirtyAgo.setDate(thirtyAgo.getDate() - 30);
  const topProducts = db.prepare(`
    SELECT si.product_name, si.product_id,
           SUM(si.quantity)    as total_qty,
           SUM(si.total_price) as total_revenue,
           SUM(si.profit)      as total_profit
    FROM sale_items si
    JOIN sales s ON si.sale_id = s.id
    WHERE s.sale_date >= ?
    GROUP BY si.product_id
    ORDER BY total_qty DESC LIMIT 5
  `).all(thirtyAgo.toISOString().split('T')[0]);

  // Low stock alerts (product level)
  const lowStockItems = db.prepare(`
    SELECT p.id, p.name, p.category, p.min_stock_level,
           COALESCE(SUM(CASE WHEN b.expiry_date IS NULL OR b.expiry_date >= ? THEN b.quantity_available ELSE 0 END),0) as total_stock
    FROM products p
    LEFT JOIN product_batches b ON b.product_id = p.id
    GROUP BY p.id
    HAVING total_stock <= p.min_stock_level
    ORDER BY total_stock ASC LIMIT 10
  `).all(today);

  // Near-expiry batch alerts
  const nearExpiryItems = db.prepare(`
    SELECT b.*, p.name as product_name, p.category
    FROM product_batches b
    JOIN products p ON b.product_id = p.id
    WHERE b.expiry_date >= ? AND b.expiry_date <= ? AND b.quantity_available > 0
    ORDER BY b.expiry_date ASC LIMIT 10
  `).all(today, nearStr);

  res.json({
    products: { total: totalProducts, totalStock, lowStock, outOfStock, nearExpiry, expired, stockValuation },
    sales: { today: todaySales, week: weekSales, month: monthSales },
    recentSales,
    recentPurchases,
    topProducts,
    alerts: { lowStock: lowStockItems, nearExpiry: nearExpiryItems }
  });
});

// ── Sales trend ──────────────────────────────────────────────────────────────
router.get('/trends', requireAuth, (req, res) => {
  const db = getDb();
  const { period = 'daily' } = req.query;
  let query;

  if (period === 'daily') {
    query = `
      SELECT sale_date as label,
             COALESCE(SUM(total_amount),0) as sales,
             COALESCE(SUM(profit),0) as profit,
             COUNT(*) as transactions
      FROM sales WHERE sale_date >= date('now','-14 days')
      GROUP BY sale_date ORDER BY sale_date ASC
    `;
  } else if (period === 'weekly') {
    query = `
      SELECT strftime('%Y-W%W', sale_date) as label,
             COALESCE(SUM(total_amount),0) as sales,
             COALESCE(SUM(profit),0) as profit,
             COUNT(*) as transactions
      FROM sales WHERE sale_date >= date('now','-56 days')
      GROUP BY strftime('%Y-%W', sale_date) ORDER BY label ASC
    `;
  } else {
    query = `
      SELECT strftime('%Y-%m', sale_date) as label,
             COALESCE(SUM(total_amount),0) as sales,
             COALESCE(SUM(profit),0) as profit,
             COUNT(*) as transactions
      FROM sales WHERE sale_date >= date('now','-180 days')
      GROUP BY strftime('%Y-%m', sale_date) ORDER BY label ASC
    `;
  }

  res.json(db.prepare(query).all());
});

// ── Full reports ─────────────────────────────────────────────────────────────
router.get('/reports', requireAuth, (req, res) => {
  const db = getDb();
  const { from, to, category } = req.query;

  if (!from || !to) return res.status(400).json({ error: 'Date range required' });

  const today = new Date().toISOString().split('T')[0];
  const nearDate = new Date(to); nearDate.setDate(nearDate.getDate() + 30);
  const nearStr = nearDate.toISOString().split('T')[0];

  // Sales summary
  const salesSummary = db.prepare(`
    SELECT COUNT(*) as transactions,
           COALESCE(SUM(total_amount),0) as total_sales,
           COALESCE(SUM(total_cost),0)   as total_cost,
           COALESCE(SUM(profit),0)       as gross_profit
    FROM sales WHERE sale_date >= ? AND sale_date <= ?
  `).get(from, to);

  // Purchase summary
  const purchaseSummary = db.prepare(`
    SELECT COUNT(*) as transactions, COALESCE(SUM(total_amount),0) as total_purchases
    FROM purchases WHERE purchase_date >= ? AND purchase_date <= ?
  `).get(from, to);

  // Best selling — profit is real batch cost
  let bestQuery = `
    SELECT si.product_name, si.product_id, p.category,
           SUM(si.quantity)    as total_qty,
           SUM(si.total_price) as total_revenue,
           SUM(si.profit)      as total_profit
    FROM sale_items si
    JOIN sales s    ON si.sale_id    = s.id
    LEFT JOIN products p ON si.product_id = p.id
    WHERE s.sale_date >= ? AND s.sale_date <= ?
  `;
  const bestParams = [from, to];
  if (category) { bestQuery += ` AND p.category = ?`; bestParams.push(category); }
  bestQuery += ` GROUP BY si.product_id ORDER BY total_qty DESC LIMIT 20`;
  const bestSelling = db.prepare(bestQuery).all(...bestParams);

  // Daily breakdown
  const dailyBreakdown = db.prepare(`
    SELECT sale_date, COUNT(*) as transactions,
           SUM(total_amount) as sales, SUM(profit) as profit
    FROM sales WHERE sale_date >= ? AND sale_date <= ?
    GROUP BY sale_date ORDER BY sale_date ASC
  `).all(from, to);

  // Stock valuation from batches
  const stockValuation = db.prepare(`
    SELECT COALESCE(SUM(b.purchase_price * b.quantity_available),0) as value,
           COUNT(DISTINCT b.product_id) as products,
           COALESCE(SUM(b.quantity_available),0) as total_qty
    FROM product_batches b
    WHERE b.expiry_date IS NULL OR b.expiry_date >= ?
  `).get(today);

  // Near-expiry batches
  const nearExpiryBatches = db.prepare(`
    SELECT b.*, p.name as product_name, p.category, s.name as supplier_name
    FROM product_batches b
    JOIN products p ON b.product_id = p.id
    LEFT JOIN suppliers s ON b.supplier_id = s.id
    WHERE b.expiry_date >= ? AND b.expiry_date <= ? AND b.quantity_available > 0
    ORDER BY b.expiry_date ASC
  `).all(today, nearStr);

  // Expired batches still holding stock
  const expiredBatches = db.prepare(`
    SELECT b.*, p.name as product_name, p.category
    FROM product_batches b
    JOIN products p ON b.product_id = p.id
    WHERE b.expiry_date < ? AND b.quantity_available > 0
    ORDER BY b.expiry_date ASC
  `).all(today);

  // Low stock (aggregate per product)
  const lowStockItems = db.prepare(`
    SELECT p.id, p.name, p.category, p.min_stock_level,
           COALESCE(SUM(CASE WHEN b.expiry_date IS NULL OR b.expiry_date >= ? THEN b.quantity_available ELSE 0 END),0) as total_stock
    FROM products p
    LEFT JOIN product_batches b ON b.product_id = p.id
    GROUP BY p.id
    HAVING total_stock <= p.min_stock_level
    ORDER BY total_stock ASC
  `).all(today);

  // Slow movers
  const slowMovers = db.prepare(`
    SELECT p.id, p.name, p.category, p.selling_price,
           COALESCE(SUM(CASE WHEN b.expiry_date IS NULL OR b.expiry_date >= ? THEN b.quantity_available ELSE 0 END),0) as total_stock
    FROM products p
    LEFT JOIN product_batches b ON b.product_id = p.id
    WHERE p.id NOT IN (
      SELECT DISTINCT si.product_id FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.sale_date >= ? AND s.sale_date <= ?
    )
    GROUP BY p.id
    HAVING total_stock > 0
    LIMIT 20
  `).all(today, from, to);

  res.json({
    period: { from, to },
    sales: salesSummary,
    purchases: purchaseSummary,
    netProfit: salesSummary.gross_profit,
    bestSelling,
    dailyBreakdown,
    stockValuation,
    slowMovers,
    lowStockItems,
    expiredBatches,
    nearExpiryBatches
  });
});

module.exports = router;
