// Registro de drivers. Para añadir un fabricante nuevo basta con crear una clase
// que extienda BaseDriver y registrarla aquí.
import { HikvisionDriver } from './hikvision.js';
import { DahuaDriver } from './dahua.js';
import { MilesightDriver } from './milesight.js';
import { GenericHttpDriver } from './generic-http.js';
import { SimulatorDriver } from './simulator.js';

export const DRIVERS = Object.fromEntries(
  [HikvisionDriver, DahuaDriver, MilesightDriver, GenericHttpDriver, SimulatorDriver].map((D) => [D.meta.id, D])
);

export function createDriver(device) {
  const D = DRIVERS[device.driver];
  if (!D) throw new Error(`Driver desconocido: ${device.driver}`);
  return new D(device);
}

export function listDrivers() {
  return Object.values(DRIVERS).map((D) => D.meta);
}
