// Dahua: cámaras ITC / ANPR vía CGI HTTP API.
// Eventos: configurar "Plataforma / HTTP Upload" (o Event Push) hacia /api/ingest/<deviceId>.
// La estructura JSON varía según firmware; se busca PlateNumber de forma tolerante.
import { BaseDriver, tryJson, findKey } from './base.js';

export class DahuaDriver extends BaseDriver {
  static meta = {
    id: 'dahua', name: 'Dahua (CGI / ITC)', capabilities: ['lpr', 'barrier'],
    help: 'Configurar HTTP Upload hacia /api/ingest/<id>. Barrera vía trafficSnap.cgi?action=openStrobe.'
  };

  parseEvent({ body, query }) {
    const text = body.toString('utf8');
    const json = tryJson(text);
    let plate = json ? findKey(json, ['PlateNumber', 'plateNumber', 'plateNo']) : undefined;
    // Formato texto clave=valor de algunos firmwares (eventManager / snapManager)
    if (!plate) plate = /PlateNumber["=:\s]+"?([A-Z0-9\- ]+)/i.exec(text)?.[1] ?? query?.plate;
    if (!plate || /unknown|^-+$/i.test(String(plate))) return [];
    const conf = json ? findKey(json, ['Confidence', 'PlateConfidence']) : undefined;
    const dir = json ? findKey(json, ['Direction', 'CarWayDirection']) : undefined;
    return [{
      plate: String(plate),
      confidence: conf !== undefined ? Number(conf) : undefined,
      direction: /approach|entry|^0$/i.test(String(dir ?? '')) ? 'entry' : /leave|exit|^1$/i.test(String(dir ?? '')) ? 'exit' : undefined
    }];
  }

  async openBarrier({ plate } = {}) {
    if (this.options.openUrl) return this.openViaUrl();
    const q = new URLSearchParams({ action: 'openStrobe', channel: String(this.device.channel || 1), 'info.openType': 'Normal' });
    if (plate) q.set('info.plateNumber', plate);
    await this.ensureOk(this.http(`/cgi-bin/trafficSnap.cgi?${q}`), 'Apertura Dahua');
  }

  async closeBarrier() {
    await this.ensureOk(this.http(`/cgi-bin/trafficSnap.cgi?action=closeStrobe&channel=${this.device.channel || 1}`), 'Cierre Dahua');
  }

  async testConnection() {
    const r = await this.http('/cgi-bin/magicBox.cgi?action=getDeviceType');
    return { ok: r.ok, info: r.ok ? r.text.trim() : `HTTP ${r.status}` };
  }
}
