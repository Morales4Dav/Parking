// Dispositivo virtual para pruebas y demos sin hardware.
import { BaseDriver, tryJson } from './base.js';

export class SimulatorDriver extends BaseDriver {
  static meta = { id: 'simulator', name: 'Simulador (sin hardware)', capabilities: ['lpr', 'barrier'], help: 'Lecturas simuladas desde el panel.' };

  parseEvent({ body, query }) {
    const json = tryJson(body.toString('utf8')) || {};
    const plate = json.plate ?? query?.plate;
    return plate ? [{ plate: String(plate), direction: json.direction }] : [];
  }

  async openBarrier() { this.lastAction = 'open'; }
  async closeBarrier() { this.lastAction = 'close'; }
  async testConnection() { return { ok: true, info: 'Simulador' }; }
}
