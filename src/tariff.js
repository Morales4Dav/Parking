// Cálculo de tarifas por fracciones con minutos de cortesía y máximo diario.

const DAY_MIN = 24 * 60;

/**
 * @param {Date|string} entryAt
 * @param {Date|string} at  momento del cálculo
 * @param {object} t        configuración de tarifa (ver DEFAULT_SETTINGS.tariff)
 * @returns {{minutes:number, amountCents:number}}
 */
export function computeFee(entryAt, at, t) {
  const ms = new Date(at) - new Date(entryAt);
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  if (minutes <= (t.graceMinutes ?? 0)) return { minutes, amountCents: 0 };

  const fullDays = Math.floor(minutes / DAY_MIN);
  const rest = minutes % DAY_MIN;
  const block = Math.max(1, t.blockMinutes);
  const cap = t.dailyCapCents > 0 ? t.dailyCapCents : Infinity;

  const blockPrice = (m) => Math.min(cap, Math.ceil(m / block) * t.pricePerBlockCents);
  const full = fullDays * (cap === Infinity ? blockPrice(DAY_MIN) : cap);
  return { minutes, amountCents: full + (rest > 0 ? blockPrice(rest) : 0) };
}

export function formatMoney(cents, currency = 'EUR') {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format((cents ?? 0) / 100);
}
