# MediStore Pharmacy Dashboard v2.0

Batch-aware pharmacy management system with FEFO stock deduction, full traceability, and light UI theme.

## Quick Start

```bash
npm install
node database/seed.js   # creates admin user
npm start               # http://localhost:3000
```

Login: **admin** / **admin123**

---

## What Changed (v1 → v2)

### Core Architecture Fix: Batch-Aware Inventory

**Old model (broken):**
```
products: id, name, batch_number, expiry_date, purchase_price, quantity
```
One product = one batch = one expiry date. Purchasing overwrote the cost.

**New model:**
```
products          → master data only (name, brand, category, selling_price, min_stock)
product_batches   → one row per received lot (batch_number, expiry_date, purchase_price, qty_available)
purchase_items    → now includes batch_number + expiry_date per line
sale_item_batch_allocations → records which batches were consumed per sale line
```

### FEFO Stock Deduction

Sales deduct stock from batches ordered by `expiry_date ASC` (earliest expiring first).  
Expired batches (expiry_date < today) are excluded from sale.  
FIFO is the fallback when expiry dates are equal (oldest receipt first via `created_at ASC`).

### Accurate Profit Calculation

Old: `profit = (selling_price − product.purchase_price) × qty`  
New: `profit = Σ (selling_price − batch.purchase_price) × units_from_that_batch`

Each `sale_item_batch_allocations` row stores `unit_cost` from the actual batch, so profit is always traceable to the real cost basis.

### Batch Traceability / Recall

- Search any batch number via **Inventory → Batch Lookup**
- See which invoice supplied it, which supplier delivered it, and how many units remain
- Each sale receipt shows which batches were consumed

---

## Migration from v1

If you have an existing `pharmacy.db`:

```bash
node database/migrate.js
```

This:
1. Renames the old `products` table to `_old_products`
2. Creates the new schema
3. Migrates each old product → new `products` row + one `product_batches` row preserving its current quantity, batch_number, expiry_date, and purchase_price

---

## API Changes

### Products
- `POST /api/products` — no longer accepts `batch_number`, `expiry_date`, `purchase_price`, `quantity`, `supplier_id`
- `GET  /api/products` — returns `total_stock`, `batch_count`, `nearest_expiry` (aggregated from batches)
- `GET  /api/products/:id` — includes `batches[]` array
- `GET  /api/products/meta/batch-search?q=` — recall/traceability search
- `GET  /api/products/:id/batches` — all batches for a product

### Purchases
- `POST /api/purchases` items now require `batch_number` (required) and `expiry_date` (optional)
- Each purchase item creates one `product_batches` row

### Sales
- `POST /api/sales` — server performs FEFO allocation automatically
- `GET  /api/sales/:id` — items include `batch_allocations[]` showing which batches were used

### Dashboard/Reports
- All stock counts, valuations, and expiry alerts are now batch-level
- Profit figures use actual consumed batch costs

---

## Edge Cases Handled

| Scenario | Behaviour |
|---|---|
| Purchase same batch number twice | Two separate batch rows (full invoice traceability) |
| Sale spans multiple batches | FEFO allocates across batches, records each in `sale_item_batch_allocations` |
| Delete purchase after partial sales | Zeroes `quantity_available` on consumed batches; fully removes unsold batches |
| Delete sale | Restores exact batch quantities via allocation trail |
| Expired batch | Excluded from sale validation and FEFO selection |
| Product with zero stock | Cannot be added to a sale (filtered from dropdown) |
| Delete product with stock | Blocked with error message |
| Stock underflow mid-transaction | Caught inside DB transaction; entire sale rolls back |
