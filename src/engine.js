// Motor de decisiones del parking: recibe lecturas de matrícula de cualquier
// fabricante, decide si se abre la barrera y mantiene estancias y ocupación.
import { EventEmitter } from 'node:events';
import { getSetting, normalizePlate } from './db.js';
import { computeFee } from './tariff.js';
import { createDriver as defaultDriverFactory } from './drivers/index.js';

export class ParkingEngine extends EventEmitter {
  constructor(db, { driverFactory = defaultDriverFactory, now = () => new Date() } = {}) {
    super();
    this.db = db;
    this.driverFactory = driverFactory;
    this.now = now;
    this.lastReads = new Map(); // `${laneId}|${plate}` -> ms
    this.driverCache = new Map();
  }

  // ---------- utilidades ----------
  driverFor(deviceId) {
    const device = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    if (!device) throw new Error(`Dispositivo ${deviceId} no existe`);
    const key = `${device.id}|${device.driver}|${device.host}|${device.port}|${device.username}|${device.password}|${device.channel}|${device.options}`;
    let entry = this.driverCache.get(device.id);
    if (!entry || entry.key !== key) {
      entry = { key, driver: this.driverFactory(device) };
      this.driverCache.set(device.id, entry);
    }
    return entry.driver;
  }

  log(evt) {
    const ts = this.now().toISOString();
    const r = this.db.prepare(
      'INSERT INTO events(ts, type, plate, lane_id, device_id, decision, reason, data) VALUES (?,?,?,?,?,?,?,?)'
    ).run(ts, evt.type, evt.plate ?? null, evt.laneId ?? null, evt.deviceId ?? null,
      evt.decision ?? null, evt.reason ?? null, evt.data ? JSON.stringify(evt.data) : null);
    const full = { id: Number(r.lastInsertRowid), ts, ...evt };
    this.emit('event', full);
    return full;
  }

  vehicle(plate) {
    return this.db.prepare('SELECT * FROM vehicles WHERE plate = ?').get(plate);
  }

  isValid(v, at) {
    const day = at.toISOString().slice(0, 10);
    if (v.valid_from && day < v.valid_from.slice(0, 10)) return false;
    if (v.valid_to && day > v.valid_to.slice(0, 10)) return false;
    return true;
  }

  openStay(plate) {
    return this.db.prepare("SELECT * FROM stays WHERE plate = ? AND status = 'inside' ORDER BY id DESC LIMIT 1").get(plate);
  }

  // ---------- entrada de lecturas ----------
  /**
   * Procesa una lectura de matrícula.
   * @param {{deviceId?:string, laneId?:string, plate:string, direction?:'entry'|'exit', confidence?:number, source?:string}} read
   */
  async handleRead(read) {
    const plate = normalizePlate(read.plate);
    if (!plate) return null;
    const lane = this.resolveLane(read);
    if (!lane) {
      return this.log({ type: 'read', plate, deviceId: read.deviceId, decision: 'ignored', reason: 'Lectura sin carril asociado', data: read });
    }

    const access = getSetting(this.db, 'access');
    const k = `${lane.id}|${plate}`;
    const nowMs = this.now().getTime();
    const prev = this.lastReads.get(k);
    this.lastReads.set(k, nowMs);
    if (prev && nowMs - prev < (access.duplicateReadSeconds ?? 10) * 1000) {
      return null; // lectura duplicada de la misma pasada
    }

    const decision = lane.direction === 'entry' ? this.decideEntry(plate, lane, access) : this.decideExit(plate, lane, access);
    const evt = this.log({
      type: lane.direction, plate, laneId: lane.id, deviceId: read.deviceId,
      decision: decision.allow ? 'open' : 'deny', reason: decision.reason,
      data: { confidence: read.confidence, source: read.source, amountCents: decision.amountCents, stayId: decision.stayId }
    });
    if (decision.allow) await this.actuate(lane, 'open', plate);
    return { ...evt, ...decision };
  }

  resolveLane({ laneId, deviceId, direction }) {
    if (laneId) return this.db.prepare('SELECT * FROM lanes WHERE id = ? AND enabled = 1').get(laneId);
    const lanes = this.db.prepare('SELECT * FROM lanes WHERE camera_device_id = ? AND enabled = 1').all(deviceId);
    if (lanes.length <= 1) return lanes[0];
    // Una misma cámara puede cubrir entrada y salida: usar el sentido que reporta.
    return lanes.find((l) => l.direction === direction) ?? lanes[0];
  }

  decideEntry(plate, lane, access) {
    const at = this.now();
    const v = this.vehicle(plate);
    if (v?.category === 'blacklist') return { allow: false, reason: 'Matrícula en lista negra' };

    const existing = this.openStay(plate);
    if (existing) {
      if (access.antiPassback) return { allow: false, reason: 'Anti-passback: el vehículo ya figura dentro' };
      this.db.prepare("UPDATE stays SET status = 'cancelled', exit_at = ? WHERE id = ?").run(at.toISOString(), existing.id);
    }

    let category = 'visitor';
    if (v && (v.category === 'subscriber' || v.category === 'whitelist')) {
      if (this.isValid(v, at)) category = v.category;
      else if (!access.allowVisitors) return { allow: false, reason: 'Abono caducado' };
    }

    if (category === 'visitor') {
      if (!access.allowVisitors) return { allow: false, reason: 'Solo abonados' };
      if (lane.zone_id) {
        const z = this.db.prepare('SELECT capacity FROM zones WHERE id = ?').get(lane.zone_id);
        const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM stays WHERE zone_id = ? AND status = 'inside'").get(lane.zone_id);
        if (z && n >= z.capacity) return { allow: false, reason: 'Parking completo' };
      }
    }

    const r = this.db.prepare(
      "INSERT INTO stays(plate, zone_id, entry_lane_id, entry_at, category) VALUES (?,?,?,?,?)"
    ).run(plate, lane.zone_id, lane.id, at.toISOString(), category);
    const label = { visitor: 'Rotación', subscriber: 'Abonado', whitelist: 'Lista blanca' }[category];
    return { allow: true, reason: `Entrada autorizada (${label})`, stayId: Number(r.lastInsertRowid), category };
  }

  decideExit(plate, lane, access) {
    const at = this.now();
    const v = this.vehicle(plate);
    const stay = this.openStay(plate);
    const privileged = v && (v.category === 'subscriber' || v.category === 'whitelist') && this.isValid(v, at);

    if (!stay) {
      if (privileged) return { allow: true, reason: 'Salida autorizada (abonado sin entrada registrada)' };
      return { allow: false, reason: 'Sin entrada registrada: requiere validación manual' };
    }

    const close = (amountCents, reason) => {
      this.db.prepare("UPDATE stays SET status = 'closed', exit_at = ?, exit_lane_id = ?, amount_cents = ? WHERE id = ?")
        .run(at.toISOString(), lane.id, amountCents, stay.id);
      return { allow: true, reason, stayId: stay.id, amountCents };
    };

    if (stay.category !== 'visitor' || privileged) return close(0, 'Salida autorizada (abonado)');

    const tariff = getSetting(this.db, 'tariff');
    const due = this.amountDue(stay, at, tariff);
    if (due <= 0) return close(stay.paid_cents ?? 0, stay.paid_cents ? 'Salida autorizada (pagado)' : 'Salida autorizada (tiempo de cortesía)');
    if (access.openOnUnpaidExit) return close(stay.paid_cents ?? 0, `Salida con importe pendiente (${(due / 100).toFixed(2)})`);
    return { allow: false, reason: `Pendiente de pago: ${(due / 100).toFixed(2)} ${tariff.currency}`, stayId: stay.id, amountCents: due };
  }

  /** Importe pendiente teniendo en cuenta el margen de salida tras el pago. */
  amountDue(stay, at, tariff) {
    if (stay.paid_at) {
      const exitDeadline = new Date(stay.paid_at).getTime() + (tariff.exitGraceMinutes ?? 15) * 60000;
      if (at.getTime() <= exitDeadline) return 0;
    }
    const { amountCents } = computeFee(stay.entry_at, at, tariff);
    return Math.max(0, amountCents - (stay.paid_cents ?? 0));
  }

  // ---------- acciones ----------
  async actuate(lane, action, plate) {
    const deviceId = lane.barrier_device_id || lane.camera_device_id;
    if (!deviceId) return;
    try {
      const d = this.driverFor(deviceId);
      if (action === 'open') await d.openBarrier({ plate });
      else await d.closeBarrier();
      this.log({ type: `barrier_${action}`, plate, laneId: lane.id, deviceId, decision: 'ok' });
    } catch (e) {
      this.log({ type: 'barrier_error', plate, laneId: lane.id, deviceId, decision: 'error', reason: e.message });
    }
  }

  async manualBarrier(laneId, action = 'open', reason = 'Apertura manual') {
    const lane = this.db.prepare('SELECT * FROM lanes WHERE id = ?').get(laneId);
    if (!lane) throw new Error('Carril no encontrado');
    this.log({ type: 'manual', laneId, decision: action, reason });
    await this.actuate(lane, action);
  }

  quote(stayId) {
    const stay = this.db.prepare('SELECT * FROM stays WHERE id = ?').get(stayId);
    if (!stay) throw new Error('Estancia no encontrada');
    const tariff = getSetting(this.db, 'tariff');
    const at = this.now();
    const { minutes, amountCents } = computeFee(stay.entry_at, at, tariff);
    return { stay, minutes, totalCents: amountCents, dueCents: Math.max(0, amountCents - (stay.paid_cents ?? 0)), currency: tariff.currency };
  }

  pay(stayId, method = 'cash') {
    const q = this.quote(stayId);
    if (q.stay.status !== 'inside') throw new Error('La estancia no está activa');
    const at = this.now().toISOString();
    this.db.prepare('UPDATE stays SET paid_cents = ?, paid_at = ? WHERE id = ?').run(q.totalCents, at, stayId);
    this.log({ type: 'payment', plate: q.stay.plate, decision: 'paid', reason: method, data: { stayId, amountCents: q.dueCents } });
    return { ...q, paidCents: q.dueCents };
  }

  closeStayManually(stayId, reason = 'Cierre manual') {
    const at = this.now().toISOString();
    const stay = this.db.prepare('SELECT * FROM stays WHERE id = ?').get(stayId);
    if (!stay) throw new Error('Estancia no encontrada');
    this.db.prepare("UPDATE stays SET status = 'cancelled', exit_at = ? WHERE id = ?").run(at, stayId);
    this.log({ type: 'manual', plate: stay.plate, decision: 'stay_cancelled', reason });
  }

  occupancy() {
    const zones = this.db.prepare(`
      SELECT z.id, z.name, z.capacity,
        (SELECT COUNT(*) FROM stays s WHERE s.zone_id = z.id AND s.status = 'inside') AS occupied
      FROM zones z ORDER BY z.name`).all();
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM stays WHERE status = 'inside'").get().n;
    return { zones, total, capacity: zones.reduce((a, z) => a + z.capacity, 0) };
  }
}
