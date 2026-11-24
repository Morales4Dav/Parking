// Contrato común que implementa cada driver de fabricante.
//
//  - parseEvent({ headers, body, query }) -> Array<{ plate, confidence?, direction?, ts?, raw? }>
//      Traduce la notificación HTTP que empuja el equipo a lecturas de matrícula.
//  - openBarrier({ plate }) / closeBarrier()  -> Promise<void>
//  - testConnection() -> Promise<{ ok, info }>
import { request } from '../lib/http-client.js';

export class BaseDriver {
  static meta = { id: 'base', name: 'Base', capabilities: [] };

  constructor(device) {
    this.device = device;
    this.options = typeof device.options === 'string' ? JSON.parse(device.options || '{}') : (device.options || {});
  }

  get baseUrl() {
    const d = this.device;
    const scheme = this.options.https ? 'https' : 'http';
    return `${scheme}://${d.host}${d.port ? ':' + d.port : ''}`;
  }

  http(path, opts = {}) {
    const url = /^https?:\/\//.test(path) ? path : this.baseUrl + path;
    return request(url, { username: this.device.username, password: this.device.password, ...opts });
  }

  async ensureOk(promise, action) {
    const res = await promise;
    if (!res.ok) throw new Error(`${action}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    return res;
  }

  /** Si el equipo no controla barrera, permite configurar una URL de relé externa. */
  async openViaUrl() {
    const { openUrl, openMethod = 'GET', openBody } = this.options;
    if (!openUrl) throw new Error(`El dispositivo ${this.device.name} no tiene barrera configurada (options.openUrl)`);
    await this.ensureOk(this.http(openUrl, { method: openMethod, body: openBody }), 'Apertura');
  }

  parseEvent() { return []; }
  async openBarrier() { return this.openViaUrl(); }
  async closeBarrier() { throw new Error('Cierre no soportado por este driver'); }
  async testConnection() { return { ok: false, info: 'No implementado' }; }
}

/** Busca recursivamente la primera clave (insensible a mayúsculas) dentro de un objeto JSON. */
export function findKey(obj, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const stack = [obj];
  while (stack.length) {
    const cur = stack.shift();
    if (!cur || typeof cur !== 'object') continue;
    for (const [k, v] of Object.entries(cur)) {
      if (wanted.includes(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) return v;
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return undefined;
}

export function xmlTag(text, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}>\\s*([^<]*?)\\s*</(?:\\w+:)?${tag}>`, 'i').exec(text);
  return m ? m[1] : undefined;
}

export function tryJson(text) {
  // Algunos equipos envían multipart: buscamos el primer bloque JSON.
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} }
  return undefined;
}
