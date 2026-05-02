const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const multer = require('multer');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- Database ----------
const db = new Database(path.join(DATA_DIR, 'fundraiser.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    organization TEXT,
    event_date TEXT NOT NULL,
    event_time TEXT,
    pin TEXT NOT NULL,
    basket_count INTEGER NOT NULL DEFAULT 60,
    org_logo TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS baskets (
    event_id INTEGER NOT NULL,
    basket_number INTEGER NOT NULL,
    ticket_number TEXT,
    description TEXT,
    picked_up INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (event_id, basket_number),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_baskets_event ON baskets(event_id);
`);

// Migration: add category and display_number columns if they don't exist (idempotent)
try { db.exec(`ALTER TABLE baskets ADD COLUMN category TEXT;`); } catch (_) { /* already exists */ }
try { db.exec(`ALTER TABLE baskets ADD COLUMN display_number INTEGER;`); } catch (_) { /* already exists */ }
db.exec(`UPDATE baskets SET display_number = basket_number WHERE display_number IS NULL;`);

const stmts = {
  insertEvent: db.prepare(`
    INSERT INTO events (name, organization, event_date, event_time, pin, basket_count, org_logo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  insertBasket: db.prepare(`
    INSERT INTO baskets (event_id, basket_number, display_number) VALUES (?, ?, ?)
  `),
  listEvents: db.prepare(`SELECT * FROM events WHERE archived = 0 ORDER BY event_date DESC, id DESC`),
  getEvent: db.prepare(`SELECT * FROM events WHERE id = ?`),
  archiveEvent: db.prepare(`UPDATE events SET archived = 1 WHERE id = ?`),
  deleteEvent: db.prepare(`DELETE FROM events WHERE id = ?`),
  listBaskets: db.prepare(`
    SELECT basket_number, display_number, ticket_number, description, picked_up, category, updated_at
    FROM baskets WHERE event_id = ? ORDER BY basket_number
  `),
  listBasketsByCategory: db.prepare(`
    SELECT basket_number FROM baskets WHERE event_id = ? AND COALESCE(category, '') = COALESCE(?, '')
    ORDER BY basket_number
  `),
  setDisplayNumber: db.prepare(`UPDATE baskets SET display_number = ? WHERE event_id = ? AND basket_number = ?`),
  getBasket: db.prepare(`SELECT * FROM baskets WHERE event_id = ? AND basket_number = ?`),
  updateBasket: db.prepare(`
    UPDATE baskets
    SET ticket_number = ?, description = ?, picked_up = ?, category = ?, updated_at = CURRENT_TIMESTAMP
    WHERE event_id = ? AND basket_number = ?
  `),
  countBaskets: db.prepare(`SELECT COUNT(*) AS n FROM baskets WHERE event_id = ?`),
  maxBasketNum: db.prepare(`SELECT COALESCE(MAX(basket_number), 0) AS n FROM baskets WHERE event_id = ?`),
  countFilledAbove: db.prepare(`SELECT COUNT(*) AS n FROM baskets WHERE event_id = ? AND basket_number > ? AND ticket_number IS NOT NULL`),
  deleteBasketsAbove: db.prepare(`DELETE FROM baskets WHERE event_id = ? AND basket_number > ?`),
  setBasketCount: db.prepare(`UPDATE events SET basket_count = ? WHERE id = ?`),
};

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
// no-cache: browser caches but always revalidates with server (304 if unchanged).
// Means edits propagate immediately without hard-refresh.
const noCacheStatic = (res) => res.setHeader('Cache-Control', 'no-cache');
app.use('/uploads', express.static(UPLOADS_DIR, { setHeaders: noCacheStatic }));
app.use('/static', express.static(PUBLIC_DIR, { setHeaders: noCacheStatic }));

// Disable caching of HTML so OptiSigns/phones always pull fresh
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || !path.extname(req.path)) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});

// ---------- Multer (logo upload) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 5);
      const id = crypto.randomBytes(8).toString('hex');
      cb(null, `logo-${id}${ext}`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|svg\+xml|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Image files only'));
  },
});

// ---------- SSE pub/sub ----------
const streams = new Map(); // eventId -> Set<res>

function broadcast(eventId, payload) {
  const set = streams.get(Number(eventId));
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch { /* ignore */ }
  }
}

// ---------- Helpers ----------
function checkPin(req, res, eventId) {
  const event = stmts.getEvent.get(eventId);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return null;
  }
  const provided = req.get('x-pin') || req.body?.pin || req.query?.pin;
  if (provided !== event.pin) {
    res.status(401).json({ error: 'Invalid PIN' });
    return null;
  }
  return event;
}

// Recompute display_number within a category: 1, 2, 3... in basket_number order.
// Called after a basket's category changes — keeps Big Ticket #1-#7 etc. tidy.
function renumberCategory(eventId, category) {
  const rows = stmts.listBasketsByCategory.all(eventId, category);
  const tx = db.transaction(() => {
    rows.forEach((r, i) => stmts.setDisplayNumber.run(i + 1, eventId, r.basket_number));
  });
  tx();
}

function mmddFromDate(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}${dd}`;
}

// ---------- Routes: pages ----------
const sendPage = (file) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, file));

app.get('/', sendPage('index.html'));
app.get('/setup', sendPage('setup.html'));
app.get('/admin/:eventId', sendPage('admin.html'));
app.get('/display/:eventId', sendPage('display.html'));
app.get('/raffle/:eventId', sendPage('list.html'));
app.get('/instructions/:eventId', sendPage('instructions.html'));

// ---------- Routes: events ----------
app.get('/api/events', (_req, res) => {
  res.json(stmts.listEvents.all());
});

app.get('/api/events/:id', (req, res) => {
  const event = stmts.getEvent.get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  // Strip pin for public display/list pages
  const isAdmin = req.get('x-pin') === event.pin;
  const { pin, ...safe } = event;
  res.json(isAdmin ? event : safe);
});

app.post('/api/events', upload.single('logo'), (req, res) => {
  const { name, organization, event_date, event_time } = req.body;
  const basket_count = Math.max(1, Math.min(200, parseInt(req.body.basket_count, 10) || 60));
  if (!name || !event_date) return res.status(400).json({ error: 'name and event_date required' });

  const pin = mmddFromDate(event_date);
  if (!pin) return res.status(400).json({ error: 'Invalid event_date' });

  const orgLogo = req.file ? req.file.filename : null;

  const insert = db.transaction(() => {
    const r = stmts.insertEvent.run(name, organization || null, event_date, event_time || null, pin, basket_count, orgLogo);
    const eventId = r.lastInsertRowid;
    for (let i = 1; i <= basket_count; i++) stmts.insertBasket.run(eventId, i, i);
    return eventId;
  });
  const eventId = insert();
  res.status(201).json({ id: eventId, pin });
});

app.delete('/api/events/:id', (req, res) => {
  const event = checkPin(req, res, req.params.id);
  if (!event) return;
  stmts.deleteEvent.run(event.id);
  res.json({ ok: true });
});

// Change basket count after creation. Adds empty baskets when growing,
// removes baskets when shrinking (refuses if the removed range has filled
// tickets, unless ?force=1).
app.patch('/api/events/:id/basket-count', (req, res) => {
  const event = checkPin(req, res, req.params.id);
  if (!event) return;
  const newCount = parseInt(req.body.basket_count, 10);
  if (!Number.isFinite(newCount) || newCount < 1 || newCount > 200) {
    return res.status(400).json({ error: 'basket_count must be 1-200' });
  }
  const currentMax = stmts.maxBasketNum.get(event.id).n;
  if (newCount === currentMax) return res.json({ ok: true, basket_count: newCount });

  const tx = db.transaction(() => {
    if (newCount > currentMax) {
      for (let i = currentMax + 1; i <= newCount; i++) stmts.insertBasket.run(event.id, i, i);
    } else {
      const filled = stmts.countFilledAbove.get(event.id, newCount).n;
      if (filled > 0 && !req.body.force) {
        const err = new Error(`${filled} basket(s) above #${newCount} have ticket numbers`);
        err.status = 409; err.filled = filled; throw err;
      }
      stmts.deleteBasketsAbove.run(event.id, newCount);
    }
    stmts.setBasketCount.run(newCount, event.id);
  });
  try { tx(); } catch (e) {
    if (e.status === 409) return res.status(409).json({ error: e.message, filled: e.filled });
    throw e;
  }
  broadcast(event.id, { type: 'event-update', basket_count: newCount });
  res.json({ ok: true, basket_count: newCount });
});

// PIN check endpoint (for admin login)
app.post('/api/events/:id/auth', (req, res) => {
  const event = stmts.getEvent.get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (req.body?.pin !== event.pin) return res.status(401).json({ error: 'Invalid PIN' });
  res.json({ ok: true });
});

// ---------- Routes: baskets ----------
app.get('/api/events/:id/baskets', (req, res) => {
  const event = stmts.getEvent.get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(stmts.listBaskets.all(event.id));
});

app.patch('/api/events/:id/baskets/:n', (req, res) => {
  const event = checkPin(req, res, req.params.id);
  if (!event) return;
  const basketNum = parseInt(req.params.n, 10);
  const existing = stmts.getBasket.get(event.id, basketNum);
  if (!existing) return res.status(404).json({ error: 'Basket not found' });

  const ticket_number = req.body.ticket_number !== undefined
    ? (req.body.ticket_number || '').toString().trim().slice(0, 20) || null
    : existing.ticket_number;
  const description = req.body.description !== undefined
    ? (req.body.description || '').toString().trim().slice(0, 100) || null
    : existing.description;
  const picked_up = req.body.picked_up !== undefined
    ? (req.body.picked_up ? 1 : 0)
    : existing.picked_up;
  const allowedCategories = new Set(['big', 'special']);
  const category = req.body.category !== undefined
    ? (allowedCategories.has(req.body.category) ? req.body.category : null)
    : existing.category;

  stmts.updateBasket.run(ticket_number, description, picked_up, category, event.id, basketNum);

  // If category changed, renumber both the OLD category (gap closed)
  // and the NEW category (this basket added in the right slot).
  const categoryChanged = (existing.category || null) !== (category || null);
  if (categoryChanged) {
    renumberCategory(event.id, existing.category || null);
    if ((category || null) !== (existing.category || null)) {
      renumberCategory(event.id, category || null);
    }
    // Broadcast event-update so all displays refetch (display numbers may have shifted)
    broadcast(event.id, { type: 'event-update' });
  }

  const updated = stmts.getBasket.get(event.id, basketNum);
  broadcast(event.id, { type: 'basket', basket: updated });
  res.json(updated);
});

// ---------- Routes: SSE ----------
app.get('/api/events/:id/stream', (req, res) => {
  const event = stmts.getEvent.get(req.params.id);
  if (!event) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`: connected\n\n`);

  const id = Number(event.id);
  if (!streams.has(id)) streams.set(id, new Set());
  streams.get(id).add(res);

  // Keepalive every 25s — well under Cloudflare's 185s timeout
  const heartbeat = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`); } catch { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    streams.get(id)?.delete(res);
  });
});

// ---------- Routes: QR ----------
app.get('/qr/:eventId.png', async (req, res) => {
  const event = stmts.getEvent.get(req.params.eventId);
  if (!event) return res.status(404).end();
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const target = req.query.target === 'admin' ? `admin/${event.id}` : `raffle/${event.id}`;
  const url = `${proto}://${host}/${target}`;
  const png = await QRCode.toBuffer(url, { width: 600, margin: 2, errorCorrectionLevel: 'M' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(png);
});

// ---------- Health ----------
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---------- Errors ----------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Fundraiser app listening on :${PORT}`);
});
