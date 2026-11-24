// Milesight: cámaras LPR con "HTTP Post" de eventos en JSON.
// La barrera suele colgarse de la salida de alarma de la cámara o de un relé externo:
// configurar options.openUrl con la URL que dispara esa salida.
import { BaseDriver, tryJson, findKey } from './base.js';

export class MilesightDriver extends BaseDriver {
  static meta = {
    id: 'milesight', name: 'Milesight LPR', capabilities: ['lpr', 'barrier'],
    help: 'Configurar HTTP Post (JSON) hacia /api/ingest/<id>. Barrera mediante options.openUrl.'
  };

  parseEvent({ body }) {
    const json = tryJson(body.toString('utf8'));
    if (!json) return [];
    const plate = findKey(json, ['plate', 'license_plate', 'plateNumber']);
    if (!plate || /^(none|unknown)$/i.test(String(plate))) return [];
    const dir = String(findKey(json, ['direction']) ?? '');
    return [{
      plate: String(plate),
      confidence: Number(findKey(json, ['confidence'])) || undefined,
      direction: /approach|in|entry/i.test(dir) ? 'entry' : /away|out|exit/i.test(dir) ? 'exit' : undefined,
      ts: findKey(json, ['time', 'timestamp'])
    }];
  }

  async testConnection() {
    const r = await this.http('/');
    return { ok: r.status < 500, info: `HTTP ${r.status}` };
  }
}
