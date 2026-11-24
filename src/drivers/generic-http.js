// Driver genérico: cualquier equipo que empuje JSON por HTTP y/o un relé
// controlable por URL (Shelly, controladoras IP, PLC con webserver...).
//
// options:
//   plateField : nombre de la clave con la matrícula (por defecto "plate")
//   openUrl    : URL para abrir (p. ej. http://10.0.0.5/relay/0?turn=on&timer=1)
//   closeUrl   : URL para cerrar (opcional)
//   openMethod / openBody : método y cuerpo HTTP para la apertura
import { BaseDriver, tryJson, findKey } from './base.js';

export class GenericHttpDriver extends BaseDriver {
  static meta = {
    id: 'generic-http', name: 'Genérico HTTP / Relé IP', capabilities: ['lpr', 'barrier'],
    help: 'Recibe JSON en /api/ingest/<id> (o ?plate=XXXX) y abre con options.openUrl.'
  };

  parseEvent({ body, query }) {
    const json = tryJson(body.toString('utf8'));
    const plate = (json && findKey(json, [this.options.plateField || 'plate'])) ?? query?.plate;
    if (!plate) return [];
    const dir = json ? findKey(json, ['direction']) : query?.direction;
    return [{ plate: String(plate), direction: dir === 'entry' || dir === 'exit' ? dir : undefined }];
  }

  async closeBarrier() {
    if (!this.options.closeUrl) throw new Error('options.closeUrl no configurado');
    await this.ensureOk(this.http(this.options.closeUrl), 'Cierre');
  }

  async testConnection() {
    const url = this.options.testUrl || this.options.openUrl?.replace(/\?.*$/, '') || this.baseUrl;
    const r = await this.http(url, { method: 'HEAD' }).catch((e) => ({ ok: false, status: e.message }));
    return { ok: r.ok || (r.status >= 200 && r.status < 500), info: `HTTP ${r.status}` };
  }
}
