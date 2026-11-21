import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { db } from './database.js';
import { createSession, requireAuth, revokeSession } from './auth.js';

const app = express();
const API_PREFIX = '/api';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new HttpError(status, message);
}

function numberValue(value, label, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(400, label + ' harus berupa angka yang valid.');
  if (options.min !== undefined && number < options.min) fail(400, label + ' minimal ' + options.min + '.');
  if (options.max !== undefined && number > options.max) fail(400, label + ' maksimal ' + options.max + '.');
  return number;
}

function requiredText(value, label, max = 150) {
  if (typeof value !== 'string' || !value.trim()) fail(400, label + ' wajib diisi.');
  const result = value.trim();
  if (result.length > max) fail(400, label + ' maksimal ' + max + ' karakter.');
  return result;
}

function optionalText(value, label, max = 500) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(400, label + ' harus berupa teks.');
  const result = value.trim();
  if (result.length > max) fail(400, label + ' maksimal ' + max + ' karakter.');
  return result || null;
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return numberValue(value, label, { min: 1 });
}

function validDate(value, label, fallback = null) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback;
    fail(400, label + ' wajib diisi.');
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(400, label + ' tidak valid.');
  return new Date(value).toISOString();
}

function adminView(row) {
  return { id: row.id, username: row.username };
}

function categoryRows() {
  return db.prepare('SELECT id, name, created_at, updated_at FROM categories ORDER BY name COLLATE NOCASE ASC').all();
}

function itemQuery(where = '', params = []) {
  return db.prepare(`
    SELECT i.*, c.name AS category_name,
      CASE WHEN i.current_stock <= i.minimum_stock THEN 1 ELSE 0 END AS is_low_stock,
      i.current_stock * i.cost_price AS stock_cost_value,
      i.current_stock * i.outgoing_price AS stock_outgoing_value
    FROM items i
    LEFT JOIN categories c ON c.id = i.category_id
    ${where ? 'WHERE ' + where : ''}
    ORDER BY i.name COLLATE NOCASE ASC, i.id ASC
  `).all(...params);
}

function findItem(id) {
  const row = db.prepare(`
    SELECT i.*, c.name AS category_name,
      CASE WHEN i.current_stock <= i.minimum_stock THEN 1 ELSE 0 END AS is_low_stock,
      i.current_stock * i.cost_price AS stock_cost_value,
      i.current_stock * i.outgoing_price AS stock_outgoing_value
    FROM items i
    LEFT JOIN categories c ON c.id = i.category_id
    WHERE i.id = ? AND i.is_active = 1
  `).get(id);
  if (!row) fail(404, 'Barang tidak ditemukan.');
  return row;
}

function movementRows(where = '', params = [], limit = 100, offset = 0) {
  return db.prepare(`
    SELECT sm.*,
      i.code AS item_code,
      i.name AS item_name,
      i.unit AS unit,
      CASE WHEN sm.movement_type = 'IN' THEN sm.cost_total
           ELSE COALESCE(sm.outgoing_total, 0) END AS total_value
    FROM stock_movements sm
    JOIN items i ON i.id = sm.item_id
    ${where ? 'WHERE ' + where : ''}
    ORDER BY sm.occurred_at DESC, sm.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

function stockSummary() {
  return db.prepare(`
    SELECT
      COUNT(*) AS total_items,
      COALESCE(SUM(current_stock), 0) AS total_stock_units,
      COALESCE(SUM(current_stock * cost_price), 0) AS total_stock_cost_value,
      COALESCE(SUM(current_stock * outgoing_price), 0) AS total_stock_outgoing_value,
      COALESCE(SUM(CASE WHEN current_stock <= minimum_stock THEN 1 ELSE 0 END), 0) AS low_stock_items,
      COALESCE(SUM(CASE WHEN current_stock <= 0 THEN 1 ELSE 0 END), 0) AS empty_stock_items
    FROM items WHERE is_active = 1
  `).get();
}

function movementSummary(where = '', params = []) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total_movements,
      COALESCE(SUM(CASE WHEN movement_type = 'IN' THEN quantity ELSE 0 END), 0) AS total_in_quantity,
      COALESCE(SUM(CASE WHEN movement_type = 'OUT' THEN quantity ELSE 0 END), 0) AS total_out_quantity,
      COALESCE(SUM(CASE WHEN movement_type = 'IN' THEN cost_total ELSE 0 END), 0) AS total_in_cost_value,
      COALESCE(SUM(CASE WHEN movement_type = 'OUT' THEN cost_total ELSE 0 END), 0) AS total_out_cost_value,
      COALESCE(SUM(CASE WHEN movement_type = 'OUT' THEN outgoing_total ELSE 0 END), 0) AS total_outgoing_value,
      COALESCE(SUM(CASE WHEN movement_type = 'OUT' THEN outgoing_total - cost_total ELSE 0 END), 0) AS estimated_profit
    FROM stock_movements
    ${where ? 'WHERE ' + where : ''}
  `).get(...params);
}

function dateRangeQuery(startDate, endDate) {
  const validate = (value, name) => {
    if (!value) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) {
      fail(400, 'Format ' + name + ' tidak valid.');
    }
  };
  validate(startDate, 'startDate');
  validate(endDate, 'endDate');
  if (startDate && endDate && startDate > endDate) fail(400, 'startDate tidak boleh melewati endDate.');
  const clauses = [];
  const params = [];
  if (startDate) {
    clauses.push('date(occurred_at) >= date(?)');
    params.push(startDate);
  }
  if (endDate) {
    clauses.push('date(occurred_at) <= date(?)');
    params.push(endDate);
  }
  return { where: clauses.join(' AND '), params };
}

function ensureCategory(categoryId) {
  if (categoryId !== null && !db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) {
    fail(400, 'Kategori tidak ditemukan.');
  }
}

function createItemCode() {
  const nextId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM items').get().id);
  return 'BRG-' + String(nextId).padStart(3, '0');
}

function parseItemInput(body, creating) {
  const data = {};
  if (creating || body.name !== undefined) data.name = requiredText(body.name, 'Nama barang', 150);
  if (creating || body.unit !== undefined) data.unit = requiredText(body.unit, 'Satuan', 30);
  if (creating || body.cost_price !== undefined) data.cost_price = numberValue(body.cost_price, 'Harga modal', { min: 0 });
  if (creating || body.outgoing_price !== undefined) data.outgoing_price = numberValue(body.outgoing_price, 'Harga keluar', { min: 0 });
  if (creating || body.minimum_stock !== undefined) data.minimum_stock = numberValue(body.minimum_stock, 'Stok minimum', { min: 0 });
  if (creating || body.category_id !== undefined) data.category_id = optionalId(body.category_id, 'Kategori');
  if (creating || body.description !== undefined) data.description = optionalText(body.description, 'Deskripsi', 2000);
  if (creating) data.initial_stock = numberValue(body.initial_stock, 'Stok awal', { min: 0 });
  return data;
}

function insertStockMovement(itemId, type, body) {
  const quantity = numberValue(body.quantity, 'Jumlah', { min: Number.EPSILON });
  const item = findItem(itemId);
  if (type === 'OUT' && quantity > Number(item.current_stock)) {
    fail(400, 'Stok tidak cukup. Stok tersedia: ' + item.current_stock + ' ' + item.unit + '.');
  }

  const unitCost = type === 'IN'
    ? numberValue(body.unit_cost, 'Harga modal', { min: 0 })
    : Number(item.cost_price);
  const unitOutgoing = type === 'OUT'
    ? numberValue(body.unit_outgoing_price ?? item.outgoing_price, 'Harga keluar', { min: 0 })
    : null;
  const occurredAt = validDate(body.occurred_at, 'Tanggal transaksi', new Date().toISOString());
  const supplier = type === 'IN' ? optionalText(body.supplier, 'Supplier', 150) : null;
  const destination = type === 'OUT' ? optionalText(body.destination, 'Tujuan', 150) : null;
  const note = optionalText(body.note, 'Catatan', 500);
  const costTotal = quantity * unitCost;
  const outgoingTotal = type === 'OUT' ? quantity * unitOutgoing : null;

  const insert = db.prepare(`
    INSERT INTO stock_movements (
      item_id, movement_type, quantity, unit_cost, unit_outgoing_price,
      cost_total, outgoing_total, supplier, destination, note, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateIn = db.prepare(`
    UPDATE items
    SET current_stock = current_stock + ?, cost_price = ?,
        supplier = COALESCE(?, supplier),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND is_active = 1
  `);
  const updateOut = db.prepare(`
    UPDATE items
    SET current_stock = current_stock - ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND is_active = 1 AND current_stock >= ?
  `);

  const transaction = db.transaction(() => {
    if (type === 'IN') {
      updateIn.run(quantity, unitCost, supplier, itemId);
    } else {
      const result = updateOut.run(quantity, itemId, quantity);
      if (result.changes !== 1) fail(409, 'Stok berubah atau tidak mencukupi. Muat ulang data barang.');
    }
    const result = insert.run(
      itemId, type, quantity, unitCost, unitOutgoing,
      costTotal, outgoingTotal, supplier, destination, note, occurredAt
    );
    return Number(result.lastInsertRowid);
  });

  const movementId = transaction();
  return {
    item: findItem(itemId),
    movement: db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(movementId)
  };
}

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    const configured = (process.env.CORS_ORIGIN || '*').split(',').map((value) => value.trim()).filter(Boolean);
    if (!origin || configured.includes('*') || configured.includes(origin)) return callback(null, true);
    return callback(new HttpError(403, 'Origin tidak diizinkan oleh CORS.'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept']
}));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  const result = db.prepare('SELECT 1 AS ok').get();
  res.json({ success: true, status: result.ok === 1 ? 'ok' : 'error', database: 'sqlite' });
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' }
});

app.post(API_PREFIX + '/auth/login', loginLimiter, (req, res) => {
  const username = requiredText(req.body?.username, 'Username', 64);
  const password = requiredText(req.body?.password, 'Password', 200);
  const admin = db.prepare('SELECT id, username, password_hash, is_active FROM admins WHERE username = ? COLLATE NOCASE').get(username);

  if (!admin || admin.is_active !== 1 || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ success: false, message: 'Username atau password salah.' });
  }

  const token = createSession(admin);
  res.json({ success: true, data: { token, admin: adminView(admin) } });
});

app.use(API_PREFIX, requireAuth);

app.post(API_PREFIX + '/auth/logout', (req, res) => {
  revokeSession(req.sessionId);
  res.json({ success: true, data: null });
});

app.get(API_PREFIX + '/auth/me', (req, res) => {
  res.json({ success: true, data: { admin: req.admin } });
});

app.get(API_PREFIX + '/dashboard', (req, res) => {
  const stock = stockSummary();
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  const month = today.slice(0, 7);
  const daily = movementSummary('date(occurred_at) = date(?)', [today]);
  const monthly = movementSummary("strftime('%Y-%m', occurred_at) = ?", [month]);
  const alerts = itemQuery('i.is_active = 1 AND i.current_stock <= i.minimum_stock');
  const recent = movementRows('', [], 5, 0);

  res.json({
    success: true,
    data: { summary: { stock, monthly, daily }, stock_alerts: alerts, recent_movements: recent }
  });
});

app.get(API_PREFIX + '/categories', (req, res) => {
  res.json({ success: true, data: categoryRows() });
});

app.post(API_PREFIX + '/categories', (req, res) => {
  const name = requiredText(req.body?.name, 'Nama kategori', 100);
  const result = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(result.lastInsertRowid));
  res.status(201).json({ success: true, data: category });
});

app.patch(API_PREFIX + '/categories/:id', (req, res) => {
  const id = numberValue(req.params.id, 'ID kategori', { min: 1 });
  const name = requiredText(req.body?.name, 'Nama kategori', 100);
  const result = db.prepare(`
    UPDATE categories SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(name, id);
  if (!result.changes) fail(404, 'Kategori tidak ditemukan.');
  res.json({ success: true, data: db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
});

app.delete(API_PREFIX + '/categories/:id', (req, res) => {
  const id = numberValue(req.params.id, 'ID kategori', { min: 1 });
  const result = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  if (!result.changes) fail(404, 'Kategori tidak ditemukan.');
  res.json({ success: true, data: null });
});

app.get(API_PREFIX + '/items', (req, res) => {
  const clauses = ['i.is_active = 1'];
  const params = [];
  if (req.query.search) {
    clauses.push('(i.name LIKE ? OR i.code LIKE ?)');
    const term = '%' + String(req.query.search).slice(0, 100) + '%';
    params.push(term, term);
  }
  if (req.query.categoryId) {
    clauses.push('i.category_id = ?');
    params.push(numberValue(req.query.categoryId, 'categoryId', { min: 1 }));
  }
  if (req.query.stockStatus === 'low') clauses.push('i.current_stock <= i.minimum_stock');
  if (req.query.stockStatus === 'empty') clauses.push('i.current_stock <= 0');
  res.json({ success: true, data: itemQuery(clauses.join(' AND '), params) });
});

app.post(API_PREFIX + '/items', (req, res) => {
  const data = parseItemInput(req.body || {}, true);
  ensureCategory(data.category_id);
  const code = req.body?.code === undefined || req.body.code === ''
    ? createItemCode()
    : requiredText(req.body.code, 'Kode barang', 64);
  const result = db.prepare(`
    INSERT INTO items (
      code, name, category_id, unit, cost_price, outgoing_price,
      initial_stock, current_stock, minimum_stock, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code, data.name, data.category_id, data.unit, data.cost_price,
    data.outgoing_price, data.initial_stock, data.initial_stock,
    data.minimum_stock, data.description
  );
  res.status(201).json({ success: true, data: findItem(Number(result.lastInsertRowid)) });
});

app.get(API_PREFIX + '/items/:id', (req, res) => {
  const id = numberValue(req.params.id, 'ID barang', { min: 1 });
  res.json({ success: true, data: findItem(id) });
});

app.patch(API_PREFIX + '/items/:id', (req, res) => {
  const id = numberValue(req.params.id, 'ID barang', { min: 1 });
  findItem(id);
  const data = parseItemInput(req.body || {}, false);
  if (!Object.keys(data).length) fail(400, 'Tidak ada data yang diperbarui.');
  ensureCategory(data.category_id);

  const allowed = ['name', 'unit', 'cost_price', 'outgoing_price', 'minimum_stock', 'category_id', 'description'];
  const fields = allowed.filter((key) => Object.hasOwn(data, key));
  const assignments = fields.map((key) => key + ' = ?').join(', ');
  const values = fields.map((key) => data[key]);
  const result = db.prepare(
    'UPDATE items SET ' + assignments + ", updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND is_active = 1"
  ).run(...values, id);
  if (!result.changes) fail(404, 'Barang tidak ditemukan.');
  res.json({ success: true, data: findItem(id) });
});

app.delete(API_PREFIX + '/items/:id', (req, res) => {
  const id = numberValue(req.params.id, 'ID barang', { min: 1 });
  const result = db.prepare(`
    UPDATE items SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND is_active = 1
  `).run(id);
  if (!result.changes) fail(404, 'Barang tidak ditemukan.');
  res.json({ success: true, data: null });
});

app.post(API_PREFIX + '/items/:id/stock-in', (req, res) => {
  const id = numberValue(req.params.id, 'ID barang', { min: 1 });
  res.status(201).json({ success: true, data: insertStockMovement(id, 'IN', req.body || {}) });
});

app.post(API_PREFIX + '/items/:id/stock-out', (req, res) => {
  const id = numberValue(req.params.id, 'ID barang', { min: 1 });
  res.status(201).json({ success: true, data: insertStockMovement(id, 'OUT', req.body || {}) });
});

app.get(API_PREFIX + '/items/:id/movements', (req, res) => {
  const id = numberValue(req.params.id, 'ID barang', { min: 1 });
  findItem(id);
  const limit = Math.min(100, Math.max(1, Math.floor(numberValue(req.query.limit ?? 50, 'limit', { min: 1 }))));
  const offset = Math.max(0, Math.floor(numberValue(req.query.offset ?? 0, 'offset', { min: 0 })));
  const rows = movementRows('sm.item_id = ?', [id], limit, offset);
  res.json({ success: true, data: rows, meta: { limit, offset, count: rows.length } });
});

app.get(API_PREFIX + '/reports/summary', (req, res) => {
  res.json({ success: true, data: stockSummary() });
});

app.get(API_PREFIX + '/reports/low-stock', (req, res) => {
  res.json({ success: true, data: itemQuery('i.is_active = 1 AND i.current_stock <= i.minimum_stock') });
});

app.get(API_PREFIX + '/reports/movements', (req, res) => {
  const { where, params } = dateRangeQuery(req.query.startDate, req.query.endDate);
  res.json({
    success: true,
    period: { startDate: req.query.startDate || null, endDate: req.query.endDate || null },
    data: movementSummary(where, params)
  });
});

app.get(API_PREFIX + '/movements/recent', (req, res) => {
  const limit = Math.min(500, Math.max(1, Math.floor(numberValue(req.query.limit ?? 20, 'limit', { min: 1 }))));
  const rows = movementRows('', [], limit, 0);
  res.json({ success: true, data: rows, meta: { limit, count: rows.length } });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan.' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ success: false, message: 'Data dengan nama atau kode tersebut sudah digunakan.' });
  }
  if (error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(409).json({ success: false, message: 'Data masih digunakan oleh data lain.' });
  }
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Format JSON tidak valid.' });
  }
  console.error('[API ERROR]', error);
  return res.status(500).json({ success: false, message: 'Terjadi kesalahan internal pada server.' });
});

export default app;
