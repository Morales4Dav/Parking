import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';

let server, base;
before(async () => {
  const db = openDb(':memory:');
  seedDemo(db);
  const app = createApp({ db, adminPassword: '', ingestToken: '' });
  server = createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

test('flujo completo vía API', async () => {
  const ing = await call('POST', '/api/ingest/cam-in', { plate: '7777 TTT' });
  assert.equal(ing.data.results[0].decision, 'open');
  const st = await call('GET', '/api/status');
  assert.equal(st.data.total, 1);
  const stays = await call('GET', '/api/stays');
  assert.equal(stays.data[0].plate, '7777TTT');
  const v = await call('POST', '/api/vehicles', { plate: 'ab-12', category: 'whitelist' });
  assert.equal(v.data.plate, 'AB12');
  const ev = await call('GET', '/api/events?limit=5');
  assert.ok(ev.data.length >= 2);
});

test('errores controlados', async () => {
  assert.equal((await call('POST', '/api/ingest/nope', {})).status, 404);
  assert.equal((await call('POST', '/api/vehicles', '{malo')).status, 400);
  assert.equal((await call('POST', '/api/devices', { id: 'cam-in', name: 'x', driver: 'simulator' })).status, 409);
  assert.equal((await call('GET', '/../package.json')).status, 404);
});

test('sirve el panel web', async () => {
  const r = await fetch(base + '/');
  assert.match(await r.text(), /Parking Center/);
});
