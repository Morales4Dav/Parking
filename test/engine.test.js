import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting, getSetting } from '../src/db.js';
import { ParkingEngine } from '../src/engine.js';

let db, engine, clock, actions;
beforeEach(() => {
  db = openDb(':memory:');
  clock = new Date('2026-03-01T08:00:00Z');
  actions = [];
  const fakeDriver = (device) => ({ openBarrier: async () => actions.push(['open', device.id]), closeBarrier: async () => actions.push(['close', device.id]) });
  engine = new ParkingEngine(db, { driverFactory: fakeDriver, now: () => clock });
  db.exec(`
    INSERT INTO zones VALUES ('Z', 'Zona', 2);
    INSERT INTO devices(id, name, driver) VALUES ('cam1','c1','simulator'), ('cam2','c2','simulator'), ('bar1','b1','generic-http');
    INSERT INTO lanes(id, name, direction, camera_device_id, barrier_device_id, zone_id) VALUES
      ('IN','Entrada','entry','cam1','bar1','Z'), ('OUT','Salida','exit','cam2',NULL,'Z');
    INSERT INTO vehicles(plate, category, valid_to) VALUES ('1111AAA','subscriber','2026-12-31'), ('2222BBB','blacklist',NULL), ('3333CCC','subscriber','2025-01-01');
  `);
});
const advance = (min) => { clock = new Date(clock.getTime() + min * 60000); };

test('visitante entra, no puede salir sin pagar, paga y sale', async () => {
  const e = await engine.handleRead({ deviceId: 'cam1', plate: '9999 zzz' });
  assert.equal(e.decision, 'open');
  assert.deepEqual(actions.at(-1), ['open', 'bar1']); // abre la barrera configurada, no la cámara
  advance(90);
  const x = await engine.handleRead({ deviceId: 'cam2', plate: '9999ZZZ' });
  assert.equal(x.decision, 'deny');
  assert.equal(x.amountCents, 300);
  engine.pay(x.stayId);
  advance(5);
  const x2 = await engine.handleRead({ deviceId: 'cam2', plate: '9999ZZZ' });
  assert.equal(x2.decision, 'open');
  assert.deepEqual(actions.at(-1), ['open', 'cam2']); // sin barrera dedicada: actúa la cámara
  assert.equal(engine.occupancy().total, 0);
});

test('si tarda más del margen tras pagar, se cobra la diferencia', async () => {
  await engine.handleRead({ laneId: 'IN', plate: 'X1' });
  advance(60);
  const stay = engine.openStay('X1');
  engine.pay(stay.id);
  advance(40);
  const x = await engine.handleRead({ laneId: 'OUT', plate: 'X1' });
  assert.equal(x.decision, 'deny');
  assert.equal(x.amountCents, 150); // 100 min = 7 fracciones (350) - 200 pagados
});

test('salida gratuita dentro del tiempo de cortesía', async () => {
  await engine.handleRead({ laneId: 'IN', plate: 'X2' });
  advance(10);
  assert.equal((await engine.handleRead({ laneId: 'OUT', plate: 'X2' })).decision, 'open');
});

test('lista negra denegada, abonado sale sin pagar, abono caducado entra como visitante', async () => {
  assert.equal((await engine.handleRead({ laneId: 'IN', plate: '2222BBB' })).decision, 'deny');
  const s = await engine.handleRead({ laneId: 'IN', plate: '1111AAA' });
  assert.equal(s.category, 'subscriber');
  advance(600);
  assert.equal((await engine.handleRead({ laneId: 'OUT', plate: '1111AAA' })).decision, 'open');
  assert.equal((await engine.handleRead({ laneId: 'IN', plate: '3333CCC' })).category, 'visitor');
});

test('parking completo deniega visitantes', async () => {
  await engine.handleRead({ laneId: 'IN', plate: 'A1' });
  await engine.handleRead({ laneId: 'IN', plate: 'A2' });
  const r = await engine.handleRead({ laneId: 'IN', plate: 'A3' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /completo/);
});

test('lecturas duplicadas se ignoran y anti-passback', async () => {
  await engine.handleRead({ laneId: 'IN', plate: 'D1' });
  assert.equal(await engine.handleRead({ laneId: 'IN', plate: 'D1' }), null);
  setSetting(db, 'access', { ...getSetting(db, 'access'), antiPassback: true });
  advance(1);
  assert.equal((await engine.handleRead({ laneId: 'IN', plate: 'D1' })).decision, 'deny');
});

test('error de barrera queda registrado', async () => {
  engine.driverFactory = () => ({ openBarrier: async () => { throw new Error('timeout'); } });
  engine.driverCache.clear();
  await engine.handleRead({ laneId: 'IN', plate: 'E1' });
  const ev = db.prepare("SELECT * FROM events WHERE type = 'barrier_error'").get();
  assert.equal(ev.reason, 'timeout');
});
