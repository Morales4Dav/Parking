// Servidor HTTP: API REST, recepción de eventos de los equipos, tiempo real (SSE) y panel web.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb, getSetting, setSetting, normalizePlate } from './db.js';
import { ParkingEngine } from './engine.js';
import { listDrivers, DRIVERS } from './drivers/index.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const MAX_BODY = 10 * 1024 * 1024; // las cámaras envían imágenes en el multipart

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Cuerpo demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

const DEVICE_FIELDS = ['name', 'driver', 'host', 'port', 'username', 'password', 'channel', 'options', 'enabled'];
const publicDevice = (d) => d && ({ ...d, password: d.password ? '••••••' : '', options: JSON.parse(d.options || '{}') });

export function createApp({ db = openDb(), engine = new ParkingEngine(db), adminPassword = process.env.PARKING_ADMIN_PASSWORD, ingestToken = process.env.PARKING_INGEST_TOKEN } = {}) {
  const sseClients = new Set();
  engine.on('event', (e) => { for (const c of sseClients) c.write(`data: ${JSON.stringify(e)}\n\n`); });

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  // ---------- Ingesta de eventos de equipos ----------
  route('POST', '/api/ingest/:deviceId', async ({ params, body, query }) => {
    if (ingestToken && !safeEq(query.get('token') ?? '', ingestToken)) throw new HttpError(401, 'Token de ingesta inválido');
    const device = db.prepare('SELECT * FROM devices WHERE id = ? AND enabled = 1').get(params.deviceId);
    if (!device) throw new HttpError(404, 'Dispositivo desconocido o deshabilitado');
    const reads = engine.driverFor(device.id).parseEvent({ body, query: Object.fromEntries(query) });
    const results = [];
    for (const r of reads) results.push(await engine.handleRead({ ...r, deviceId: device.id, source: device.driver }));
    return { received: reads.length, results };
  });
  // Algunos equipos sólo hacen GET (p. ej. ?plate=1234ABC)
  routes.push({ ...routes.at(-1), method: 'GET' });

  // ---------- Estado ----------
  route('GET', '/api/status', () => ({ ...engine.occupancy(), time: engine.now().toISOString() }));
  route('GET', '/api/drivers', () => listDrivers());
  route('GET', '/api/events', ({ query }) => {
    const limit = Math.min(500, Number(query.get('limit')) || 100);
    const plate = query.get('plate');
    const rows = plate
      ? db.prepare('SELECT * FROM events WHERE plate LIKE ? ORDER BY id DESC LIMIT ?').all(`%${normalizePlate(plate)}%`, limit)
      : db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
  });

  // ---------- Dispositivos ----------
  route('GET', '/api/devices', () => db.prepare('SELECT * FROM devices ORDER BY name').all().map(publicDevice));
  route('POST', '/api/devices', ({ data }) => {
    if (!data.id || !data.name || !DRIVERS[data.driver]) throw new HttpError(400, 'id, name y driver válidos son obligatorios');
    db.prepare(`INSERT INTO devices(id, name, driver, host, port, username, password, channel, options, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(data.id, data.name, data.driver, data.host ?? null, data.port ? Number(data.port) : null, data.username ?? null,
        data.password ?? null, Number(data.channel) || 1, JSON.stringify(data.options ?? {}), data.enabled === false ? 0 : 1);
    return publicDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(data.id));
  });
  route('PUT', '/api/devices/:id', ({ params, data }) => {
    const cur = db.prepare('SELECT * FROM devices WHERE id = ?').get(params.id);
    if (!cur) throw new HttpError(404, 'No encontrado');
    const next = { ...cur };
    for (const f of DEVICE_FIELDS) if (data[f] !== undefined) next[f] = data[f];
    if (data.password === '••••••') next.password = cur.password;
    if (typeof next.options !== 'string') next.options = JSON.stringify(next.options);
    next.enabled = next.enabled === false || next.enabled === 0 ? 0 : 1;
    db.prepare('UPDATE devices SET name=?, driver=?, host=?, port=?, username=?, password=?, channel=?, options=?, enabled=? WHERE id=?')
      .run(next.name, next.driver, next.host, next.port ? Number(next.port) : null, next.username, next.password, Number(next.channel) || 1, next.options, next.enabled, params.id);
    return publicDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(params.id));
  });
  route('DELETE', '/api/devices/:id', ({ params }) => { db.prepare('DELETE FROM devices WHERE id = ?').run(params.id); return { ok: true }; });
  route('POST', '/api/devices/:id/test', async ({ params }) => {
    try { return await engine.driverFor(params.id).testConnection(); } catch (e) { return { ok: false, info: e.message }; }
  });

  // ---------- Zonas y carriles ----------
  route('GET', '/api/zones', () => db.prepare('SELECT * FROM zones ORDER BY name').all());
  route('POST', '/api/zones', ({ data }) => {
    if (!data.id || !data.name) throw new HttpError(400, 'id y name obligatorios');
    db.prepare('INSERT INTO zones(id, name, capacity) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, capacity=excluded.capacity')
      .run(data.id, data.name, Number(data.capacity) || 0);
    return { ok: true };
  });
  route('DELETE', '/api/zones/:id', ({ params }) => { db.prepare('DELETE FROM zones WHERE id = ?').run(params.id); return { ok: true }; });

  route('GET', '/api/lanes', () => db.prepare('SELECT * FROM lanes ORDER BY name').all());
  route('POST', '/api/lanes', ({ data }) => {
    if (!data.id || !data.name || !['entry', 'exit'].includes(data.direction)) throw new HttpError(400, 'id, name y direction (entry/exit) obligatorios');
    db.prepare(`INSERT INTO lanes(id, name, direction, camera_device_id, barrier_device_id, zone_id, enabled) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, direction=excluded.direction, camera_device_id=excluded.camera_device_id,
      barrier_device_id=excluded.barrier_device_id, zone_id=excluded.zone_id, enabled=excluded.enabled`)
      .run(data.id, data.name, data.direction, data.camera_device_id || null, data.barrier_device_id || null, data.zone_id || null, data.enabled === false ? 0 : 1);
    return { ok: true };
  });
  route('DELETE', '/api/lanes/:id', ({ params }) => { db.prepare('DELETE FROM lanes WHERE id = ?').run(params.id); return { ok: true }; });
  route('POST', '/api/lanes/:id/open', async ({ params, data }) => { await engine.manualBarrier(params.id, 'open', data.reason || 'Apertura manual'); return { ok: true }; });
  route('POST', '/api/lanes/:id/close', async ({ params }) => { await engine.manualBarrier(params.id, 'close', 'Cierre manual'); return { ok: true }; });
  // Simular una lectura en un carril (pruebas y lectura manual de matrícula por el operador)
  route('POST', '/api/lanes/:id/read', async ({ params, data }) => {
    if (!data.plate) throw new HttpError(400, 'plate obligatorio');
    return engine.handleRead({ laneId: params.id, plate: data.plate, source: 'manual' });
  });

  // ---------- Vehículos (abonados / listas) ----------
  route('GET', '/api/vehicles', () => db.prepare('SELECT * FROM vehicles ORDER BY category, plate').all());
  route('POST', '/api/vehicles', ({ data }) => {
    const plate = normalizePlate(data.plate);
    if (!plate) throw new HttpError(400, 'Matrícula obligatoria');
    const category = data.category || 'subscriber';
    if (!['subscriber', 'whitelist', 'blacklist'].includes(category)) throw new HttpError(400, 'Categoría inválida');
    db.prepare(`INSERT INTO vehicles(plate, owner, category, valid_from, valid_to, notes) VALUES (?,?,?,?,?,?)
      ON CONFLICT(plate) DO UPDATE SET owner=excluded.owner, category=excluded.category, valid_from=excluded.valid_from, valid_to=excluded.valid_to, notes=excluded.notes`)
      .run(plate, data.owner || null, category, data.valid_from || null, data.valid_to || null, data.notes || null);
    return db.prepare('SELECT * FROM vehicles WHERE plate = ?').get(plate);
  });
  route('DELETE', '/api/vehicles/:plate', ({ params }) => { db.prepare('DELETE FROM vehicles WHERE plate = ?').run(normalizePlate(params.plate)); return { ok: true }; });

  // ---------- Estancias y pagos ----------
  route('GET', '/api/stays', ({ query }) => {
    const status = query.get('status') || 'inside';
    const plate = query.get('plate');
    const rows = plate
      ? db.prepare('SELECT * FROM stays WHERE plate LIKE ? ORDER BY id DESC LIMIT 200').all(`%${normalizePlate(plate)}%`)
      : db.prepare('SELECT * FROM stays WHERE status = ? ORDER BY id DESC LIMIT 500').all(status);
    return rows.map((s) => {
      if (s.status !== 'inside' || s.category !== 'visitor') return s;
      const q = engine.quote(s.id);
      return { ...s, minutes: q.minutes, due_cents: q.dueCents };
    });
  });
  route('GET', '/api/stays/:id/quote', ({ params }) => engine.quote(Number(params.id)));
  route('POST', '/api/stays/:id/pay', ({ params, data }) => engine.pay(Number(params.id), data.method || 'cash'));
  route('POST', '/api/stays/:id/cancel', ({ params, data }) => { engine.closeStayManually(Number(params.id), data.reason); return { ok: true }; });

  route('GET', '/api/reports/summary', ({ query }) => {
    const from = query.get('from') || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const to = query.get('to') || new Date().toISOString().slice(0, 10);
    const toEnd = to + 'T23:59:59.999Z';
    return {
      from, to,
      entries: db.prepare("SELECT COUNT(*) n FROM stays WHERE entry_at BETWEEN ? AND ?").get(from, toEnd).n,
      exits: db.prepare("SELECT COUNT(*) n FROM stays WHERE status = 'closed' AND exit_at BETWEEN ? AND ?").get(from, toEnd).n,
      revenueCents: db.prepare("SELECT COALESCE(SUM(paid_cents),0) n FROM stays WHERE paid_at BETWEEN ? AND ?").get(from, toEnd).n,
      denied: db.prepare("SELECT COUNT(*) n FROM events WHERE decision = 'deny' AND ts BETWEEN ? AND ?").get(from, toEnd).n,
      barrierErrors: db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'barrier_error' AND ts BETWEEN ? AND ?").get(from, toEnd).n
    };
  });

  // ---------- Configuración ----------
  route('GET', '/api/settings', () => ({ tariff: getSetting(db, 'tariff'), access: getSetting(db, 'access') }));
  route('PUT', '/api/settings', ({ data }) => {
    for (const key of ['tariff', 'access']) if (data[key]) setSetting(db, key, { ...getSetting(db, key), ...data[key] });
    return { tariff: getSetting(db, 'tariff'), access: getSetting(db, 'access') };
  });

  // ---------- Manejador principal ----------
  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const isIngest = url.pathname.startsWith('/api/ingest/');
        if (adminPassword && !isIngest) {
          const [, b64] = (req.headers.authorization || '').split(' ');
          const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
          if (!safeEq(pass ?? '', adminPassword)) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Parking"' });
            return res.end();
          }
        }
        if (url.pathname === '/api/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.write(': ok\n\n');
          sseClients.add(res);
          const ka = setInterval(() => res.write(': ka\n\n'), 25000);
          req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
          return;
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
          let data = {};
          if (!isIngest && body.length) {
            try { data = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido'); }
          }
          const result = await r.handler({ params, query: url.searchParams, body, data, req });
          return json(res, 200, result ?? { ok: true });
        }
        throw new HttpError(404, 'Ruta no encontrada');
      }

      // Ficheros estáticos del panel
      if (req.method !== 'GET') throw new HttpError(405, 'Método no permitido');
      const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Prohibido');
      const content = await readFile(file).catch(() => { throw new HttpError(404, 'No encontrado'); });
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(content);
    } catch (e) {
      const status = e.status || (/UNIQUE|constraint/i.test(e.message) ? 409 : /no encontrad|no existe/i.test(e.message) ? 404 : 500);
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, status, { error: e.message });
    }
  }

  return { handler, db, engine, sseClients };
}

// Arranque directo: `node src/server.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 8080;
  const app = createApp();
  if (process.env.PARKING_DEMO === '1' || app.db.prepare('SELECT COUNT(*) n FROM devices').get().n === 0) {
    const { seedDemo } = await import('./seed.js');
    seedDemo(app.db);
  }
  createServer(app.handler).listen(port, () => {
    console.log(`Parking Center escuchando en http://localhost:${port}`);
    if (!process.env.PARKING_ADMIN_PASSWORD) console.warn('Aviso: PARKING_ADMIN_PASSWORD no definido, la API no requiere autenticación.');
  });
}
