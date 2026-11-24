// Hikvision: cámaras ANPR y terminales de parking vía ISAPI.
// Eventos: configurar en la cámara "Alarm Server / HTTP Listening" apuntando a
//   http://<servidor>:<puerto>/api/ingest/<deviceId>
// La cámara envía EventNotificationAlert (XML, a veces dentro de multipart con imágenes)
// o JSON en firmwares recientes.
import { BaseDriver, xmlTag, tryJson, findKey } from './base.js';

const BARRIER_XML = (mode) =>
  `<?xml version="1.0" encoding="UTF-8"?><BarrierGate version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><ctrlMode>${mode}</ctrlMode></BarrierGate>`;

export class HikvisionDriver extends BaseDriver {
  static meta = {
    id: 'hikvision', name: 'Hikvision (ISAPI)', capabilities: ['lpr', 'barrier'],
    help: 'Configurar Alarm Server HTTP hacia /api/ingest/<id>. Barrera vía /ISAPI/Parking/channels/<canal>/barrierGate.'
  };

  parseEvent({ body }) {
    const text = body.toString('latin1');
    if (text.includes('EventNotificationAlert') || text.includes('<licensePlate>')) {
      const eventType = xmlTag(text, 'eventType');
      if (eventType && !/anpr|vehicle/i.test(eventType)) return [];
      const plate = xmlTag(text, 'licensePlate');
      if (!plate || /unknown/i.test(plate)) return [];
      const dir = xmlTag(text, 'direction');
      return [{
        plate,
        confidence: Number(xmlTag(text, 'confidenceLevel')) || undefined,
        direction: dir === 'forward' ? 'entry' : dir === 'reverse' ? 'exit' : undefined,
        ts: xmlTag(text, 'dateTime'),
        raw: { eventType }
      }];
    }
    const json = tryJson(text);
    if (json) {
      const plate = findKey(json, ['licensePlate', 'plateNo', 'plate']);
      if (plate && !/unknown/i.test(plate)) return [{ plate: String(plate), confidence: Number(findKey(json, ['confidenceLevel'])) || undefined }];
    }
    return [];
  }

  async openBarrier() {
    if (this.options.openUrl) return this.openViaUrl();
    await this.ensureOk(this.http(`/ISAPI/Parking/channels/${this.device.channel || 1}/barrierGate`, {
      method: 'PUT', body: BARRIER_XML('open'), headers: { 'Content-Type': 'application/xml' }
    }), 'Apertura Hikvision');
  }

  async closeBarrier() {
    await this.ensureOk(this.http(`/ISAPI/Parking/channels/${this.device.channel || 1}/barrierGate`, {
      method: 'PUT', body: BARRIER_XML('close'), headers: { 'Content-Type': 'application/xml' }
    }), 'Cierre Hikvision');
  }

  async testConnection() {
    const r = await this.http('/ISAPI/System/deviceInfo');
    return { ok: r.ok, info: r.ok ? `${xmlTag(r.text, 'model') ?? ''} ${xmlTag(r.text, 'firmwareVersion') ?? ''}`.trim() : `HTTP ${r.status}` };
  }
}
