// ============================================================
// MEDISTORE — Batch-Aware Pharmacy Dashboard  v2.0
// ============================================================

// ── STATE ────────────────────────────────────────────────────────────────────
let allProducts  = [];
let allSuppliers = [];
let currentPage  = 'dashboard';
let invPage = 1; const INV_PER_PAGE = 15;
let purPage = 1; const PUR_PER_PAGE = 20;
let salPage = 1; const SAL_PER_PAGE = 20;
let filteredInv  = [];
let salesChartInstance  = null;
let profitChartInstance = null;
let lastReportData = null;

// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('topbarDate').textContent =
    new Date().toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const thirtyBack = new Date(); thirtyBack.setDate(thirtyBack.getDate() - 30);
  const thirtyStr  = thirtyBack.toISOString().split('T')[0];
  document.getElementById('purFrom').value = thirtyStr;
  document.getElementById('purTo').value   = today;
  document.getElementById('salFrom').value = thirtyStr;
  document.getElementById('salTo').value   = today;
  document.getElementById('repFrom').value =
    new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  document.getElementById('repTo').value   = today;

  const me = await apiFetch('/api/me');
  if (me) document.getElementById('userLabel').textContent = me.fullName || me.username;

  await loadSuppliers();
  await loadDashboard();
  await loadTrend('daily');
  loadInventory();
});

// ── NAVIGATION ───────────────────────────────────────────────────────────────
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  const titles = { dashboard:'Dashboard', inventory:'Inventory', purchases:'Purchases',
                   sales:'Sales', suppliers:'Suppliers', reports:'Reports' };
  document.getElementById('pageTitle').textContent = titles[page] || page;
  currentPage = page;
  if (page === 'inventory')  loadInventory();
  if (page === 'purchases')  loadPurchases();
  if (page === 'sales')      loadSales();
  if (page === 'suppliers')  loadSuppliers(true);
  if (page === 'reports')    loadCategories();
}

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('mobile-open'); }

// ── API HELPERS ───────────────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, { headers:{ 'Content-Type':'application/json' }, ...options });
    if (res.status === 401) { window.location.href = '/login'; return null; }
    return await res.json();
  } catch(e) { console.error('API error:', e); return null; }
}

async function doLogout() {
  await apiFetch('/api/logout', { method:'POST' });
  window.location.href = '/login';
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'success') {
  const el = document.getElementById('toastAlert');
  const icons = { success:'✅', error:'❌', warning:'⚠️' };
  document.getElementById('toastIcon').textContent = icons[type] || '✅';
  document.getElementById('toastMsg').textContent  = msg;
  el.className = `alert alert-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ── MODAL ─────────────────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
});
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

// ── FORMAT ────────────────────────────────────────────────────────────────────
const fmt     = n => '₹' + (parseFloat(n)||0).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 });
const fmtDate = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-IN') : '—';

function statusBadge(status) {
  const map = {
    in_stock:    ['badge-success','In Stock'],
    low_stock:   ['badge-warning','Low Stock'],
    out_of_stock:['badge-danger','Out of Stock'],
    near_expiry: ['badge-warning','Near Expiry'],
    expired:     ['badge-danger','Expired'],
  };
  const [cls, label] = map[status] || ['badge-muted', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ── CHARTS ────────────────────────────────────────────────────────────────────
// Light-theme aware canvas chart
class SimpleLineChart {
  constructor(canvas, labels, data, label, color) {
    this.canvas = canvas; this.labels = labels;
    this.data = data; this.label = label; this.color = color;
    this.draw();
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(canvas.parentElement);
  }
  destroy() { this._ro?.disconnect(); }
  draw() {
    const { canvas, labels, data, color } = this;
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width  = rect.width * dpr;
    canvas.height = 220 * dpr;
    canvas.style.width  = rect.width + 'px';
    canvas.style.height = '220px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = 220;
    const pad = { top:20, right:20, bottom:48, left:72 };
    const cW = W - pad.left - pad.right, cH = H - pad.top - pad.bottom;
    ctx.clearRect(0, 0, W, H);

    if (!data.length) {
      ctx.fillStyle = '#94a3b8'; ctx.font = '13px Sora,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data available', W/2, H/2); return;
    }

    const max = Math.max(...data, 0), min = 0, range = max - min || 1;

    // Grid lines — light grey
    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (cH/5)*i;
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      const val = max - (range/5)*i;
      ctx.fillStyle = '#94a3b8'; ctx.font = '10px JetBrains Mono,monospace';
      ctx.textAlign = 'right';
      ctx.fillText('₹'+val.toLocaleString('en-IN',{maximumFractionDigits:0}), pad.left-8, y+4);
    }

    // X labels
    ctx.fillStyle = '#94a3b8'; ctx.font = '10px Sora,sans-serif'; ctx.textAlign = 'center';
    const step = Math.max(1, Math.ceil(labels.length/7));
    labels.forEach((lbl,i) => {
      if (i % step !== 0 && i !== labels.length-1) return;
      const x = pad.left + (i/Math.max(data.length-1,1))*cW;
      ctx.fillText(lbl, x, H - pad.bottom + 18);
    });

    const pts = data.map((v,i) => ({
      x: pad.left + (i/Math.max(data.length-1,1))*cW,
      y: pad.top  + (1-(v-min)/range)*cH
    }));

    // Area fill
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top+cH);
    grad.addColorStop(0, color+'30');
    grad.addColorStop(1, color+'06');
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pad.top+cH);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length-1].x, pad.top+cH);
    ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

    // Line
    ctx.beginPath();
    pts.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round'; ctx.stroke();

    // Dots
    pts.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI*2);
      ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
    });
  }
}

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
  const data = await apiFetch('/api/dashboard/stats');
  if (!data) return;

  document.getElementById('s-total').textContent  = data.products.total;
  document.getElementById('s-stock').textContent  = data.products.totalStock.toLocaleString();
  document.getElementById('s-low').textContent    = data.products.lowStock;
  document.getElementById('s-out').textContent    = data.products.outOfStock;
  document.getElementById('s-near').textContent   = data.products.nearExpiry;
  document.getElementById('s-exp').textContent    = data.products.expired;

  document.getElementById('s-tsales').textContent   = fmt(data.sales.today.total);
  document.getElementById('s-tsales-c').textContent = `${data.sales.today.count} transactions`;
  document.getElementById('s-tprofit').textContent  = fmt(data.sales.today.profit);
  document.getElementById('s-wsales').textContent   = fmt(data.sales.week.total);
  document.getElementById('s-wprofit').textContent  = fmt(data.sales.week.profit);
  document.getElementById('s-msales').textContent   = fmt(data.sales.month.total);
  document.getElementById('s-mprofit').textContent  = fmt(data.sales.month.profit);

  if (data.products.lowStock > 0) {
    const b = document.getElementById('badge-low');
    b.textContent = data.products.lowStock; b.style.display = 'inline';
  }

  document.getElementById('recentSalesTbody').innerHTML = data.recentSales.length === 0
    ? `<tr><td colspan="4" class="empty-state">No sales yet</td></tr>`
    : data.recentSales.map(s => `<tr>
        <td>${fmtDate(s.sale_date)}</td>
        <td>${s.customer_name||'Walk-in'}</td>
        <td class="text-right font-mono">${fmt(s.total_amount)}</td>
        <td class="text-right font-mono text-success">${fmt(s.profit)}</td>
      </tr>`).join('');

  document.getElementById('topProductsTbody').innerHTML = data.topProducts.length === 0
    ? `<tr><td colspan="4" class="empty-state">No data</td></tr>`
    : data.topProducts.map((p,i) => `<tr>
        <td><strong>${i+1}</strong></td>
        <td>${p.product_name}</td>
        <td>${p.total_qty}</td>
        <td class="text-right font-mono">${fmt(p.total_revenue)}</td>
      </tr>`).join('');

  document.getElementById('lowStockTbody').innerHTML = data.alerts.lowStock.length === 0
    ? `<tr><td colspan="4" class="text-center text-muted" style="padding:16px">✅ No low stock issues</td></tr>`
    : data.alerts.lowStock.map(p => `<tr>
        <td>${p.name}</td>
        <td><span class="badge badge-muted">${p.category||'—'}</span></td>
        <td><strong class="text-${p.total_stock===0?'danger':'warning'}">${p.total_stock}</strong></td>
        <td class="text-muted">${p.min_stock_level}</td>
      </tr>`).join('');

  document.getElementById('nearExpiryTbody').innerHTML = data.alerts.nearExpiry.length === 0
    ? `<tr><td colspan="4" class="text-center text-muted" style="padding:16px">✅ No near-expiry batches</td></tr>`
    : data.alerts.nearExpiry.map(b => {
        const days = Math.ceil((new Date(b.expiry_date) - new Date()) / 86400000);
        return `<tr>
          <td>${b.product_name}</td>
          <td><code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px">${b.batch_number}</code></td>
          <td>${b.quantity_available}</td>
          <td class="text-warning">${b.expiry_date} <small>(${days}d)</small></td>
        </tr>`;
      }).join('');
}

async function loadTrend(period) {
  document.querySelectorAll('.trend-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-period="${period}"]`)?.classList.add('active');
  const data = await apiFetch(`/api/dashboard/trends?period=${period}`);
  if (!data) return;

  const labels = data.map(d => {
    if (period === 'monthly') {
      const [y,m] = d.label.split('-');
      return new Date(y, parseInt(m)-1).toLocaleString('en-IN',{month:'short',year:'2-digit'});
    }
    if (period === 'weekly') return d.label;
    return new Date(d.label+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'});
  });
  const sales   = data.map(d => parseFloat(d.sales)||0);
  const profits = data.map(d => parseFloat(d.profit)||0);

  if (salesChartInstance)  salesChartInstance.destroy();
  if (profitChartInstance) profitChartInstance.destroy();
  salesChartInstance  = new SimpleLineChart(document.getElementById('salesChart'),  labels, sales,   'Sales',  '#0d9488');
  profitChartInstance = new SimpleLineChart(document.getElementById('profitChart'), labels, profits, 'Profit', '#059669');
}

// ============================================================
// INVENTORY
// ============================================================
async function loadInventory() {
  const search   = document.getElementById('invSearch')?.value   || '';
  const category = document.getElementById('invCategory')?.value || '';
  const status   = document.getElementById('invStatus')?.value   || '';

  let url = `/api/products?search=${encodeURIComponent(search)}`;
  if (category) url += `&category=${encodeURIComponent(category)}`;
  if (status)   url += `&status=${status}`;

  allProducts = await apiFetch(url) || [];
  filteredInv = allProducts;

  const cats   = await apiFetch('/api/products/meta/categories') || [];
  const catSel = document.getElementById('invCategory');
  if (catSel && catSel.options.length <= 1) cats.forEach(c => catSel.add(new Option(c,c)));
  const repCat = document.getElementById('repCategory');
  if (repCat && repCat.options.length <= 1) cats.forEach(c => repCat.add(new Option(c,c)));

  // Stock valuation from aggregated batch data
  const val = allProducts.reduce((s,p) => s + (p.total_stock||0) * 0, 0); // valuation comes from dashboard
  document.getElementById('invCount').textContent = allProducts.length;
  renderInventoryPage();
}

function filterInventory() { invPage = 1; loadInventory(); }

function renderInventoryPage() {
  const start     = (invPage-1) * INV_PER_PAGE;
  const pageItems = filteredInv.slice(start, start+INV_PER_PAGE);
  const tbody     = document.getElementById('inventoryTbody');
  const today     = new Date().toISOString().split('T')[0];

  if (pageItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">📦</div>No products found</div></td></tr>`;
    renderPagination('invPagination', filteredInv.length, INV_PER_PAGE, invPage, p=>{invPage=p; renderInventoryPage();});
    return;
  }

  tbody.innerHTML = pageItems.map(p => {
    const rowDim = (p.stock_status==='expired'||p.stock_status==='out_of_stock') ? 'style="opacity:0.75"' : '';
    const expiryHtml = p.nearest_expiry
      ? `<span class="${p.nearest_expiry < today ? 'text-danger' : p.nearest_expiry <= new Date(Date.now()+30*86400000).toISOString().split('T')[0] ? 'text-warning' : ''}">${p.nearest_expiry}</span>`
      : '<span class="text-muted">—</span>';

    return `<tr ${rowDim}>
      <td><strong>${p.name}</strong>${p.generic_name?`<br><small class="text-muted">${p.generic_name}</small>`:''}</td>
      <td class="text-muted">${p.brand||'—'}</td>
      <td>${p.category?`<span class="badge badge-info">${p.category}</span>`:'—'}</td>
      <td class="font-mono">${fmt(p.selling_price)}</td>
      <td><strong class="${p.total_stock===0?'text-danger':p.total_stock<=p.min_stock_level?'text-warning':'text-success'}">${p.total_stock||0}</strong></td>
      <td><span class="badge badge-teal">${p.batch_count||0} batch${p.batch_count===1?'':'es'}</span></td>
      <td>${expiryHtml}</td>
      <td>${statusBadge(p.stock_status)}</td>
      <td>
        <div class="flex gap-4">
          <button class="btn btn-sm btn-outline" onclick="viewProductBatches(${p.id},'${esc(p.name)}')" title="View Batches">📋</button>
          <button class="btn btn-sm btn-outline btn-icon" onclick="editProduct(${p.id})" title="Edit">✏️</button>
          <button class="btn btn-sm btn-outline btn-icon" onclick="deleteProduct(${p.id},'${esc(p.name)}')" title="Delete">🗑️</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  renderPagination('invPagination', filteredInv.length, INV_PER_PAGE, invPage, p=>{invPage=p; renderInventoryPage();});
}

function esc(s) { return (s||'').replace(/'/g, "\\'"); }

// ── View all batches for a product ───────────────────────────────────────────
async function viewProductBatches(id, name) {
  const data = await apiFetch(`/api/products/${id}`);
  if (!data) return;

  const today = new Date().toISOString().split('T')[0];
  const batches = data.batches || [];

  document.getElementById('detailTitle').textContent = `Batches — ${name}`;
  document.getElementById('detailBody').innerHTML = `
    <div style="margin-bottom:16px;font-size:13px;color:var(--text-soft)">
      Total available stock (non-expired): <strong class="text-teal">${data.total_stock}</strong> ${data.unit||'units'}
    </div>
    <div class="table-wrap">
      <table class="batch-table">
        <thead><tr>
          <th>Batch No.</th><th>Expiry</th><th>Purchase ₹</th>
          <th>Received</th><th>Available</th><th>Supplier</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${batches.length === 0
            ? `<tr><td colspan="7" class="empty-state">No batches yet — add stock via Purchases</td></tr>`
            : batches.map(b => {
                const isExpired  = b.expiry_date && b.expiry_date < today;
                const isNearExp  = b.expiry_date && !isExpired && b.expiry_date <= new Date(Date.now()+30*86400000).toISOString().split('T')[0];
                const statusBadgeHtml = isExpired
                  ? '<span class="badge badge-danger">Expired</span>'
                  : isNearExp
                  ? '<span class="badge badge-warning">Near Expiry</span>'
                  : b.quantity_available > 0
                  ? '<span class="badge badge-success">Active</span>'
                  : '<span class="badge badge-muted">Depleted</span>';
                return `<tr>
                  <td><code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px">${b.batch_number}</code></td>
                  <td class="${isExpired?'text-danger':isNearExp?'text-warning':''}">${b.expiry_date||'—'}</td>
                  <td class="font-mono">${fmt(b.purchase_price)}</td>
                  <td>${b.quantity_received}</td>
                  <td><strong>${b.quantity_available}</strong></td>
                  <td>${b.supplier_name||'—'}</td>
                  <td>${statusBadgeHtml}</td>
                </tr>`;
              }).join('')
          }
        </tbody>
      </table>
    </div>
    <div class="info-box" style="margin-top:16px">
      💡 To add more stock for this product, create a <strong>Purchase</strong> entry with this product's batch number and expiry date.
    </div>`;

  openModal('detailModal');
}

// ── Product modal ─────────────────────────────────────────────────────────────
async function openProductModal(id = null) {
  document.getElementById('productModalTitle').textContent = id ? 'Edit Medicine' : 'Add Medicine';
  document.getElementById('prodId').value = '';
  ['prodName','prodGeneric','prodBrand','prodCategory','prodDosageForm','prodSellingPrice','prodDesc'].forEach(f => {
    const el = document.getElementById(f); if (el) el.value = '';
  });
  document.getElementById('prodMinStock').value = '10';
  document.getElementById('prodUnit').value     = 'tablet';

  if (id) {
    const p = await apiFetch(`/api/products/${id}`);
    if (p) {
      document.getElementById('prodId').value          = p.id;
      document.getElementById('prodName').value        = p.name;
      document.getElementById('prodGeneric').value     = p.generic_name||'';
      document.getElementById('prodBrand').value       = p.brand||'';
      document.getElementById('prodCategory').value    = p.category||'';
      document.getElementById('prodDosageForm').value  = p.dosage_form||'';
      document.getElementById('prodUnit').value        = p.unit||'tablet';
      document.getElementById('prodSellingPrice').value= p.selling_price;
      document.getElementById('prodMinStock').value    = p.min_stock_level;
      document.getElementById('prodDesc').value        = p.description||'';
    }
  }
  openModal('productModal');
}

async function editProduct(id) { openProductModal(id); }

async function saveProduct() {
  const id   = document.getElementById('prodId').value;
  const body = {
    name:          document.getElementById('prodName').value.trim(),
    generic_name:  document.getElementById('prodGeneric').value.trim(),
    brand:         document.getElementById('prodBrand').value.trim(),
    category:      document.getElementById('prodCategory').value,
    dosage_form:   document.getElementById('prodDosageForm').value.trim(),
    unit:          document.getElementById('prodUnit').value,
    selling_price: document.getElementById('prodSellingPrice').value,
    min_stock_level: document.getElementById('prodMinStock').value,
    description:   document.getElementById('prodDesc').value.trim(),
  };

  if (!body.name)          { showToast('Product name is required','error'); return; }
  if (!body.selling_price) { showToast('Selling price is required','error'); return; }

  const url    = id ? `/api/products/${id}` : '/api/products';
  const method = id ? 'PUT' : 'POST';
  const res    = await apiFetch(url, { method, body: JSON.stringify(body) });
  if (res?.success) {
    showToast(res.message || 'Saved successfully');
    closeModal('productModal');
    loadInventory();
    if (currentPage === 'dashboard') loadDashboard();
  } else {
    showToast(res?.error || 'Failed to save','error');
  }
}

async function deleteProduct(id, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  const res = await apiFetch(`/api/products/${id}`, { method:'DELETE' });
  if (res?.success) {
    showToast('Product deleted');
    loadInventory();
    if (currentPage === 'dashboard') loadDashboard();
  } else {
    showToast(res?.error || 'Failed to delete','error');
  }
}

// ── Batch search / recall ─────────────────────────────────────────────────────
function openBatchSearch() {
  document.getElementById('batchSearchInput').value = '';
  document.getElementById('batchSearchResults').innerHTML =
    `<div class="empty-state"><div class="empty-icon">🔍</div>Enter a batch number above to search</div>`;
  openModal('batchSearchModal');
}

let batchSearchTimer;
async function runBatchSearch() {
  clearTimeout(batchSearchTimer);
  batchSearchTimer = setTimeout(async () => {
    const q = document.getElementById('batchSearchInput').value.trim();
    const container = document.getElementById('batchSearchResults');
    if (!q) { container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div>Enter a batch number above</div>`; return; }

    const results = await apiFetch(`/api/products/meta/batch-search?q=${encodeURIComponent(q)}`);
    if (!results || results.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div>No batches found for "${q}"</div>`;
      return;
    }

    container.innerHTML = `
      <div class="table-wrap">
        <table class="batch-table">
          <thead><tr>
            <th>Product</th><th>Batch No.</th><th>Expiry</th>
            <th>Available</th><th>Supplier</th><th>Purchase Date</th><th>Invoice</th>
          </tr></thead>
          <tbody>
            ${results.map(b => `<tr>
              <td><strong>${b.product_name}</strong>${b.category?`<br><small class="text-muted">${b.category}</small>`:''}</td>
              <td><code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px">${b.batch_number}</code></td>
              <td>${b.expiry_date||'—'}</td>
              <td><strong>${b.quantity_available}</strong> / ${b.quantity_received}</td>
              <td>${b.supplier_name||'—'}</td>
              <td>${b.purchase_date ? fmtDate(b.purchase_date) : '—'}</td>
              <td class="font-mono" style="font-size:11px">${b.invoice_number||'—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }, 300);
}

// ============================================================
// PURCHASES
// ============================================================
let purchaseRows = [];

async function loadPurchases() {
  const from = document.getElementById('purFrom').value;
  const to   = document.getElementById('purTo').value;
  let url    = '/api/purchases?';
  if (from) url += `from=${from}&`;
  if (to)   url += `to=${to}`;

  const data  = await apiFetch(url) || [];
  const total = data.reduce((s,p) => s + p.total_amount, 0);
  document.getElementById('purTotal').textContent = fmt(total);

  const tbody = document.getElementById('purchasesTbody');
  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">🛒</div>No purchases found</div></td></tr>`;
    return;
  }

  const start     = (purPage-1) * PUR_PER_PAGE;
  const pageItems = data.slice(start, start+PUR_PER_PAGE);

  tbody.innerHTML = pageItems.map(p => `
    <tr>
      <td>${fmtDate(p.purchase_date)}</td>
      <td class="font-mono" style="font-size:12px">${p.invoice_number||'—'}</td>
      <td>${p.supplier_name||'—'}</td>
      <td>${p.item_count||'—'}</td>
      <td class="text-right font-mono">${fmt(p.total_amount)}</td>
      <td>
        <div class="flex gap-4">
          <button class="btn btn-sm btn-outline" onclick="viewPurchase(${p.id})">View</button>
          <button class="btn btn-sm btn-outline btn-icon" onclick="deletePurchase(${p.id})" title="Delete">🗑️</button>
        </div>
      </td>
    </tr>`).join('');

  renderPagination('purPagination', data.length, PUR_PER_PAGE, purPage, p=>{purPage=p; loadPurchases();});
}

async function openPurchaseModal() {
  purchaseRows = [];
  document.getElementById('purchaseRows').innerHTML   = '';
  document.getElementById('purGrandTotal').textContent = '₹0.00';
  document.getElementById('purDate').value     = new Date().toISOString().split('T')[0];
  document.getElementById('purInvoice').value  = '';
  document.getElementById('purNotes').value    = '';

  const supSel = document.getElementById('purSupplier');
  supSel.innerHTML = '<option value="">Select Supplier</option>';
  allSuppliers.forEach(s => supSel.add(new Option(s.name, s.id)));

  // Refresh product list for up-to-date selection
  allProducts = await apiFetch('/api/products') || allProducts;

  addPurchaseRow();
  openModal('purchaseModal');
}

function addPurchaseRow() {
  const rowId   = Date.now();
  purchaseRows.push(rowId);
  const container = document.getElementById('purchaseRows');
  const div       = document.createElement('div');
  div.className   = 'items-list-row purchase-row';
  div.id          = `pr-${rowId}`;

  div.innerHTML = `
    <select onchange="updatePurRow(${rowId})">
      <option value="">Select Product</option>
      ${allProducts.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
    </select>
    <input type="text" placeholder="e.g. BATCH-001" title="Batch Number (manufacturer lot)" oninput="updatePurRow(${rowId})">
    <input type="date" title="Expiry Date" onchange="updatePurRow(${rowId})">
    <input type="number" min="1" placeholder="1" value="1" onchange="updatePurRow(${rowId})">
    <input type="number" min="0" step="0.01" placeholder="0.00" onchange="updatePurRow(${rowId})">
    <span class="font-mono text-muted" id="prtotal-${rowId}">₹0.00</span>
    <button class="remove-row" onclick="removePurRow(${rowId})">✕</button>
  `;
  container.appendChild(div);
}

function updatePurRow(rowId) {
  const row   = document.getElementById(`pr-${rowId}`);
  const qty   = parseFloat(row.querySelectorAll('input')[2].value) || 0;
  const price = parseFloat(row.querySelectorAll('input')[3].value) || 0;
  document.getElementById(`prtotal-${rowId}`).textContent = fmt(qty * price);
  updatePurTotal();
}

function removePurRow(rowId) {
  document.getElementById(`pr-${rowId}`)?.remove();
  purchaseRows = purchaseRows.filter(r => r !== rowId);
  updatePurTotal();
}

function updatePurTotal() {
  let total = 0;
  document.querySelectorAll('[id^="prtotal-"]').forEach(el => {
    total += parseFloat(el.textContent.replace('₹','').replace(/,/g,'')) || 0;
  });
  document.getElementById('purGrandTotal').textContent = fmt(total);
}

async function savePurchase() {
  const items = [];
  for (const rowId of purchaseRows) {
    const row = document.getElementById(`pr-${rowId}`);
    if (!row) continue;
    const inputs      = row.querySelectorAll('input');
    const productId   = row.querySelector('select').value;
    const batchNumber = inputs[0].value.trim();
    const expiryDate  = inputs[1].value;
    const qty         = inputs[2].value;
    const price       = inputs[3].value;

    if (!productId)   { showToast('Select a product for all rows','error'); return; }
    if (!batchNumber) { showToast('Batch number is required for all rows','error'); return; }
    if (!qty || !price) continue;

    items.push({
      product_id:   parseInt(productId),
      batch_number: batchNumber,
      expiry_date:  expiryDate || null,
      quantity:     parseInt(qty),
      unit_price:   parseFloat(price)
    });
  }

  if (items.length === 0) { showToast('Add at least one item','error'); return; }

  const body = {
    purchase_date:  document.getElementById('purDate').value,
    supplier_id:    document.getElementById('purSupplier').value || null,
    invoice_number: document.getElementById('purInvoice').value,
    notes:          document.getElementById('purNotes').value,
    items
  };

  const res = await apiFetch('/api/purchases', { method:'POST', body: JSON.stringify(body) });
  if (res?.success) {
    showToast('Purchase recorded — batches created');
    closeModal('purchaseModal');
    loadPurchases(); loadInventory();
    if (currentPage === 'dashboard') loadDashboard();
  } else {
    showToast(res?.error || 'Failed to save purchase','error');
  }
}

async function viewPurchase(id) {
  const data = await apiFetch(`/api/purchases/${id}`);
  if (!data) return;
  document.getElementById('detailTitle').textContent = `Purchase — ${data.invoice_number||'#'+id}`;
  document.getElementById('detailBody').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;font-size:13px">
      <div><span class="text-muted">Date:</span> <strong>${fmtDate(data.purchase_date)}</strong></div>
      <div><span class="text-muted">Supplier:</span> <strong>${data.supplier_name||'—'}</strong></div>
      <div><span class="text-muted">Invoice:</span> <strong class="font-mono">${data.invoice_number||'—'}</strong></div>
      <div><span class="text-muted">Total:</span> <strong class="font-mono text-teal">${fmt(data.total_amount)}</strong></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Product</th><th>Batch No.</th><th>Expiry</th><th>Qty</th><th>Unit Price</th><th class="text-right">Total</th></tr></thead>
        <tbody>
          ${(data.items||[]).map(i => `<tr>
            <td>${i.product_name}</td>
            <td><code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px">${i.batch_number}</code></td>
            <td>${i.expiry_date||'—'}</td>
            <td>${i.quantity}</td>
            <td class="font-mono">${fmt(i.unit_price)}</td>
            <td class="text-right font-mono">${fmt(i.total_price)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  openModal('detailModal');
}

async function deletePurchase(id) {
  if (!confirm('Delete this purchase? Unsold batch stock will be removed.')) return;
  const res = await apiFetch(`/api/purchases/${id}`, { method:'DELETE' });
  if (res?.success) { showToast('Purchase deleted'); loadPurchases(); loadInventory(); }
  else showToast(res?.error || 'Failed to delete','error');
}

// ============================================================
// SALES
// ============================================================
let saleRows = [];

async function loadSales() {
  const from = document.getElementById('salFrom').value;
  const to   = document.getElementById('salTo').value;
  let url    = '/api/sales?';
  if (from) url += `from=${from}&`;
  if (to)   url += `to=${to}`;

  const data   = await apiFetch(url) || [];
  const total  = data.reduce((s,p) => s + p.total_amount, 0);
  const profit = data.reduce((s,p) => s + p.profit, 0);
  document.getElementById('salTotal').textContent  = fmt(total);
  document.getElementById('salProfit').textContent = fmt(profit);

  const tbody = document.getElementById('salesTbody');
  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">💰</div>No sales found</div></td></tr>`;
    return;
  }

  const start     = (salPage-1) * SAL_PER_PAGE;
  const pageItems = data.slice(start, start+SAL_PER_PAGE);

  tbody.innerHTML = pageItems.map(s => `
    <tr>
      <td>${fmtDate(s.sale_date)}</td>
      <td>${s.customer_name||'Walk-in'}</td>
      <td>${s.item_count||'—'}</td>
      <td class="text-right font-mono">${fmt(s.total_amount)}</td>
      <td class="text-right font-mono text-success">${fmt(s.profit)}</td>
      <td>
        <div class="flex gap-4">
          <button class="btn btn-sm btn-outline" onclick="viewSale(${s.id})">View</button>
          <button class="btn btn-sm btn-outline btn-icon" onclick="deleteSale(${s.id})" title="Delete">🗑️</button>
        </div>
      </td>
    </tr>`).join('');

  renderPagination('salPagination', data.length, SAL_PER_PAGE, salPage, p=>{salPage=p; loadSales();});
}

async function openSaleModal() {
  saleRows = [];
  document.getElementById('saleRows').innerHTML       = '';
  document.getElementById('salGrandTotal').textContent = '₹0.00';
  document.getElementById('salEstProfit').textContent  = '₹0.00';
  document.getElementById('salDate').value     = new Date().toISOString().split('T')[0];
  document.getElementById('salCustomer').value = '';
  document.getElementById('salNotes').value    = '';

  // Refresh for latest stock totals
  allProducts = await apiFetch('/api/products') || allProducts;
  addSaleRow();
  openModal('saleModal');
}

function addSaleRow() {
  const rowId     = Date.now();
  const today     = new Date().toISOString().split('T')[0];
  saleRows.push(rowId);
  const container = document.getElementById('saleRows');
  const div       = document.createElement('div');
  div.className   = 'items-list-row';
  div.id          = `sr-${rowId}`;

  // Only show products with available non-expired stock
  const available = allProducts.filter(p => (p.total_stock||0) > 0);

  div.innerHTML = `
    <select onchange="updateSaleRow(${rowId})">
      <option value="">Select Product</option>
      ${available.map(p => `<option value="${p.id}" data-price="${p.selling_price}" data-stock="${p.total_stock}">${p.name} (${p.total_stock} available)</option>`).join('')}
    </select>
    <span id="sravail-${rowId}" class="text-muted" style="font-size:12px;text-align:center">—</span>
    <input type="number" min="1" placeholder="1" value="1" onchange="updateSaleRow(${rowId})">
    <input type="number" min="0" step="0.01" placeholder="0.00" onchange="updateSaleRow(${rowId})">
    <span class="font-mono text-muted" id="srtotal-${rowId}">₹0.00</span>
    <button class="remove-row" onclick="removeSaleRow(${rowId})">✕</button>
  `;
  container.appendChild(div);

  div.querySelector('select').addEventListener('change', function() {
    const opt = this.options[this.selectedIndex];
    if (opt.dataset.price) div.querySelectorAll('input')[1].value = opt.dataset.price;
    document.getElementById(`sravail-${rowId}`).textContent = opt.dataset.stock ? `${opt.dataset.stock} avail.` : '—';
    updateSaleRow(rowId);
  });
}

function updateSaleRow(rowId) {
  const row    = document.getElementById(`sr-${rowId}`);
  const select = row.querySelector('select');
  const opt    = select.options[select.selectedIndex];
  const qty    = parseInt(row.querySelectorAll('input')[0].value) || 0;
  const price  = parseFloat(row.querySelectorAll('input')[1].value) || 0;
  const stock  = parseInt(opt?.dataset?.stock) || 0;

  if (qty > stock && stock > 0) {
    row.querySelectorAll('input')[0].style.borderColor = 'var(--danger)';
  } else {
    row.querySelectorAll('input')[0].style.borderColor = '';
  }

  document.getElementById(`srtotal-${rowId}`).textContent = fmt(qty * price);
  updateSaleTotal();
}

function removeSaleRow(rowId) {
  document.getElementById(`sr-${rowId}`)?.remove();
  saleRows = saleRows.filter(r => r !== rowId);
  updateSaleTotal();
}

function updateSaleTotal() {
  let total = 0;
  saleRows.forEach(rowId => {
    const row = document.getElementById(`sr-${rowId}`);
    if (!row) return;
    const qty   = parseInt(row.querySelectorAll('input')[0].value) || 0;
    const price = parseFloat(row.querySelectorAll('input')[1].value) || 0;
    total += qty * price;
  });
  document.getElementById('salGrandTotal').textContent = fmt(total);
  // Note: estimated profit is approximate (real profit uses actual batch costs server-side)
  document.getElementById('salEstProfit').textContent  = '(calculated on save)';
}

async function saveSale() {
  const items = [];
  for (const rowId of saleRows) {
    const row = document.getElementById(`sr-${rowId}`);
    if (!row) continue;
    const productId = row.querySelector('select').value;
    const qty       = row.querySelectorAll('input')[0].value;
    const price     = row.querySelectorAll('input')[1].value;
    if (!productId || !qty || !price) continue;
    items.push({ product_id: parseInt(productId), quantity: parseInt(qty), unit_price: parseFloat(price) });
  }

  if (items.length === 0) { showToast('Add at least one item','error'); return; }

  const body = {
    sale_date:     document.getElementById('salDate').value,
    customer_name: document.getElementById('salCustomer').value,
    notes:         document.getElementById('salNotes').value,
    items
  };

  const res = await apiFetch('/api/sales', { method:'POST', body: JSON.stringify(body) });
  if (res?.success) {
    showToast('Sale recorded (FEFO batches allocated)');
    closeModal('saleModal');
    loadSales(); loadInventory();
    if (currentPage === 'dashboard') loadDashboard();
  } else {
    showToast(res?.error || 'Failed to save sale','error');
  }
}

async function viewSale(id) {
  const data = await apiFetch(`/api/sales/${id}`);
  if (!data) return;
  document.getElementById('detailTitle').textContent = `Sale Bill — #${id}`;
  document.getElementById('detailBody').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;font-size:13px">
      <div><span class="text-muted">Date:</span> <strong>${fmtDate(data.sale_date)}</strong></div>
      <div><span class="text-muted">Customer:</span> <strong>${data.customer_name||'Walk-in'}</strong></div>
      <div><span class="text-muted">Total:</span> <strong class="font-mono text-teal">${fmt(data.total_amount)}</strong></div>
      <div><span class="text-muted">Profit:</span> <strong class="font-mono text-success">${fmt(data.profit)}</strong></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Product</th><th>Qty</th><th>Unit Price</th><th>Batch(es) Used</th><th class="text-right">Total</th><th class="text-right">Profit</th></tr></thead>
        <tbody>
          ${(data.items||[]).map(i => {
            const batchInfo = (i.batch_allocations||[]).map(a =>
              `<span class="badge badge-teal" style="font-size:10px">${a.batch_number} ×${a.quantity}</span>`
            ).join(' ');
            return `<tr>
              <td>${i.product_name}</td>
              <td>${i.quantity}</td>
              <td class="font-mono">${fmt(i.unit_price)}</td>
              <td>${batchInfo||'—'}</td>
              <td class="text-right font-mono">${fmt(i.total_price)}</td>
              <td class="text-right font-mono text-success">${fmt(i.profit)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  openModal('detailModal');
}

async function deleteSale(id) {
  if (!confirm('Delete this sale? Batch stock will be fully restored.')) return;
  const res = await apiFetch(`/api/sales/${id}`, { method:'DELETE' });
  if (res?.success) { showToast('Sale deleted, batch stock restored'); loadSales(); loadInventory(); }
  else showToast(res?.error || 'Failed to delete','error');
}

// ============================================================
// SUPPLIERS
// ============================================================
async function loadSuppliers(renderTable = false) {
  allSuppliers = await apiFetch('/api/suppliers') || [];
  if (!renderTable) return;

  const tbody = document.getElementById('suppliersTbody');
  tbody.innerHTML = allSuppliers.length === 0
    ? `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">🚚</div>No suppliers added</div></td></tr>`
    : allSuppliers.map(s => `
      <tr>
        <td>${s.id}</td>
        <td><strong>${s.name}</strong></td>
        <td>${s.contact||'—'}</td>
        <td class="text-muted">${s.address||'—'}</td>
        <td>${s.email||'—'}</td>
        <td>
          <div class="flex gap-4">
            <button class="btn btn-sm btn-outline" onclick="editSupplier(${s.id})">Edit</button>
            <button class="btn btn-sm btn-outline btn-icon" onclick="deleteSupplier(${s.id},'${esc(s.name)}')">🗑️</button>
          </div>
        </td>
      </tr>`).join('');
}

function openSupplierModal() {
  document.getElementById('supplierModalTitle').textContent = 'Add Supplier';
  document.getElementById('supId').value = '';
  ['supName','supContact','supAddress','supEmail'].forEach(f => document.getElementById(f).value = '');
  openModal('supplierModal');
}

function editSupplier(id) {
  const s = allSuppliers.find(s => s.id === id);
  if (!s) return;
  document.getElementById('supplierModalTitle').textContent = 'Edit Supplier';
  document.getElementById('supId').value      = s.id;
  document.getElementById('supName').value    = s.name;
  document.getElementById('supContact').value = s.contact||'';
  document.getElementById('supAddress').value = s.address||'';
  document.getElementById('supEmail').value   = s.email||'';
  openModal('supplierModal');
}

async function saveSupplier() {
  const id   = document.getElementById('supId').value;
  const body = {
    name:    document.getElementById('supName').value.trim(),
    contact: document.getElementById('supContact').value.trim(),
    address: document.getElementById('supAddress').value.trim(),
    email:   document.getElementById('supEmail').value.trim(),
  };
  if (!body.name) { showToast('Supplier name required','error'); return; }

  const url    = id ? `/api/suppliers/${id}` : '/api/suppliers';
  const method = id ? 'PUT' : 'POST';
  const res    = await apiFetch(url, { method, body: JSON.stringify(body) });
  if (res?.success || res?.id) {
    showToast('Supplier saved');
    closeModal('supplierModal');
    loadSuppliers(true);
  } else showToast(res?.error || 'Failed','error');
}

async function deleteSupplier(id, name) {
  if (!confirm(`Delete supplier "${name}"?`)) return;
  const res = await apiFetch(`/api/suppliers/${id}`, { method:'DELETE' });
  if (res?.success) { showToast('Supplier deleted'); loadSuppliers(true); }
  else showToast('Failed to delete','error');
}

// ============================================================
// REPORTS
// ============================================================
async function loadCategories() {
  const cats = await apiFetch('/api/products/meta/categories') || [];
  const sel  = document.getElementById('repCategory');
  if (sel.options.length <= 1) cats.forEach(c => sel.add(new Option(c,c)));
}

function setReportPreset(preset) {
  const today = new Date(); const todayStr = today.toISOString().split('T')[0];
  if (preset === 'today') {
    document.getElementById('repFrom').value = todayStr;
    document.getElementById('repTo').value   = todayStr;
  } else if (preset === 'week') {
    const ws = new Date(today); ws.setDate(today.getDate() - today.getDay());
    document.getElementById('repFrom').value = ws.toISOString().split('T')[0];
    document.getElementById('repTo').value   = todayStr;
  } else if (preset === 'month') {
    document.getElementById('repFrom').value = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    document.getElementById('repTo').value   = todayStr;
  }
}

async function loadReport() {
  const from     = document.getElementById('repFrom').value;
  const to       = document.getElementById('repTo').value;
  const category = document.getElementById('repCategory').value;

  if (!from || !to)  { showToast('Select date range','error'); return; }
  if (from > to)     { showToast('From must be before To','error'); return; }

  let url = `/api/dashboard/reports?from=${from}&to=${to}`;
  if (category) url += `&category=${encodeURIComponent(category)}`;

  const data = await apiFetch(url);
  if (!data) return;
  lastReportData = data;

  document.getElementById('reportContent').style.display = 'block';

  document.getElementById('repStats').innerHTML = `
    <div class="stat-card success">
      <div class="stat-label">Total Sales</div>
      <div class="stat-value font-mono">${fmt(data.sales.total_sales)}</div>
      <div class="stat-sub">${data.sales.transactions} transactions</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Purchases</div>
      <div class="stat-value font-mono">${fmt(data.purchases.total_purchases)}</div>
      <div class="stat-sub">${data.purchases.transactions} orders</div>
    </div>
    <div class="stat-card success">
      <div class="stat-label">Gross Profit</div>
      <div class="stat-value font-mono">${fmt(data.sales.gross_profit)}</div>
      <div class="stat-sub">${data.sales.total_sales > 0 ? ((data.sales.gross_profit/data.sales.total_sales)*100).toFixed(1)+'% margin' : '—'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Cost of Goods Sold</div>
      <div class="stat-value font-mono">${fmt(data.sales.total_cost)}</div>
    </div>
    <div class="stat-card info">
      <div class="stat-label">Stock Valuation</div>
      <div class="stat-value font-mono">${fmt(data.stockValuation.value)}</div>
      <div class="stat-sub">${data.stockValuation.products} products</div>
    </div>
    <div class="stat-card warning">
      <div class="stat-label">Low Stock Items</div>
      <div class="stat-value">${data.lowStockItems.length}</div>
    </div>
  `;

  document.getElementById('repBestTbody').innerHTML = data.bestSelling.length === 0
    ? `<tr><td colspan="6" class="empty-state">No sales in this period</td></tr>`
    : data.bestSelling.map((p,i) => `<tr>
        <td><strong>${i+1}</strong></td>
        <td>${p.product_name}</td>
        <td>${p.category?`<span class="badge badge-info">${p.category}</span>`:'—'}</td>
        <td><strong>${p.total_qty}</strong></td>
        <td class="text-right font-mono">${fmt(p.total_revenue)}</td>
        <td class="text-right font-mono text-success">${fmt(p.total_profit)}</td>
      </tr>`).join('');

  document.getElementById('repDailyTbody').innerHTML = data.dailyBreakdown.length === 0
    ? `<tr><td colspan="4" class="empty-state">No data</td></tr>`
    : data.dailyBreakdown.map(d => `<tr>
        <td>${fmtDate(d.sale_date)}</td>
        <td>${d.transactions}</td>
        <td class="text-right font-mono">${fmt(d.sales)}</td>
        <td class="text-right font-mono text-success">${fmt(d.profit)}</td>
      </tr>`).join('');

  document.getElementById('repNearExpiryTbody').innerHTML = (data.nearExpiryBatches||[]).length === 0
    ? `<tr><td colspan="5" class="text-center text-muted" style="padding:16px">✅ No near-expiry batches</td></tr>`
    : data.nearExpiryBatches.map(b => `<tr>
        <td>${b.product_name}</td>
        <td><code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px">${b.batch_number}</code></td>
        <td>${b.quantity_available}</td>
        <td class="text-warning">${b.expiry_date}</td>
        <td>${b.supplier_name||'—'}</td>
      </tr>`).join('');

  document.getElementById('repExpiredTbody').innerHTML = (data.expiredBatches||[]).length === 0
    ? `<tr><td colspan="4" class="text-center text-muted" style="padding:16px">✅ No expired stock</td></tr>`
    : data.expiredBatches.map(b => `<tr>
        <td>${b.product_name}</td>
        <td><code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px">${b.batch_number}</code></td>
        <td class="text-danger">${b.quantity_available}</td>
        <td class="text-danger">${b.expiry_date}</td>
      </tr>`).join('');

  document.getElementById('repSlowTbody').innerHTML = data.slowMovers.length === 0
    ? `<tr><td colspan="4"><div class="text-center text-muted" style="padding:16px">✅ All products sold in this period</div></td></tr>`
    : data.slowMovers.map(p => `<tr>
        <td>${p.name}</td>
        <td>${p.category?`<span class="badge badge-muted">${p.category}</span>`:'—'}</td>
        <td class="text-warning">${p.total_stock}</td>
        <td class="text-right font-mono">${fmt(p.selling_price)}</td>
      </tr>`).join('');

  document.getElementById('repAlertsSummary').innerHTML = `
    <div style="font-size:13px;line-height:2.2">
      <div>🔴 <strong>Expired batches with stock:</strong> ${data.expiredBatches?.length||0}</div>
      <div>🟡 <strong>Near-expiry batches (30 days):</strong> ${data.nearExpiryBatches?.length||0}</div>
      <div>⚠️ <strong>Low stock products:</strong> ${data.lowStockItems.length}</div>
      <div>💰 <strong>Profit margin:</strong> ${data.sales.total_sales > 0 ? ((data.netProfit/data.sales.total_sales)*100).toFixed(1)+'%' : '—'}</div>
      <div>📦 <strong>Stock value:</strong> ${fmt(data.stockValuation.value)}</div>
    </div>
    ${data.lowStockItems.length > 0 ? `
    <div style="margin-top:12px">
      <div class="section-title">Low Stock Products</div>
      ${data.lowStockItems.map(p => `<div class="badge badge-warning" style="margin:2px">${p.name} (${p.total_stock})</div>`).join(' ')}
    </div>` : ''}
  `;
}

function exportCSV() {
  if (!lastReportData) { showToast('Generate a report first','warning'); return; }
  const d = lastReportData;
  let csv = 'Product,Category,Quantity Sold,Revenue,Profit\n';
  d.bestSelling.forEach(p => {
    csv += `"${p.product_name}","${p.category||''}",${p.total_qty},${p.total_revenue.toFixed(2)},${p.total_profit.toFixed(2)}\n`;
  });
  csv += `\nSummary\nTotal Sales,${d.sales.total_sales.toFixed(2)}\n`;
  csv += `Total Cost,${d.sales.total_cost.toFixed(2)}\n`;
  csv += `Gross Profit,${d.sales.gross_profit.toFixed(2)}\n`;
  csv += `\nNear-Expiry Batches\nProduct,Batch,Qty,Expiry,Supplier\n`;
  (d.nearExpiryBatches||[]).forEach(b => {
    csv += `"${b.product_name}","${b.batch_number}",${b.quantity_available},"${b.expiry_date}","${b.supplier_name||''}"\n`;
  });

  const blob = new Blob([csv], { type:'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `report-${d.period.from}-to-${d.period.to}.csv`;
  a.click();
}

// ============================================================
// PAGINATION
// ============================================================
function renderPagination(containerId, total, perPage, current, onPage) {
  const container = document.getElementById(containerId);
  const pages = Math.ceil(total / perPage);
  if (pages <= 1) { container.innerHTML = ''; return; }

  let html = '';
  if (current > 1) html += `<button class="page-btn" onclick="(${onPage.toString()})(${current-1})">‹</button>`;

  let start = Math.max(1, current-2), end = Math.min(pages, current+2);
  if (start > 1) html += `<button class="page-btn" onclick="(${onPage.toString()})(1)">1</button>${start>2?'<span class="text-muted">…</span>':''}`;
  for (let i=start; i<=end; i++)
    html += `<button class="page-btn ${i===current?'active':''}" onclick="(${onPage.toString()})(${i})">${i}</button>`;
  if (end < pages) html += `${end<pages-1?'<span class="text-muted">…</span>':''}<button class="page-btn" onclick="(${onPage.toString()})(${pages})">${pages}</button>`;
  if (current < pages) html += `<button class="page-btn" onclick="(${onPage.toString()})(${current+1})">›</button>`;

  container.innerHTML = html;
}
