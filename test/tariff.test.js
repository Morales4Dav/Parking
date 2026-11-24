import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFee } from '../src/tariff.js';

const T = { graceMinutes: 15, blockMinutes: 15, pricePerBlockCents: 50, dailyCapCents: 2000 };
const at = (min) => new Date(Date.UTC(2026, 0, 1, 0, min));

test('dentro del tiempo de cortesía no se cobra', () => {
  assert.equal(computeFee(at(0), at(15), T).amountCents, 0);
});
test('se cobra por fracciones completas', () => {
  assert.equal(computeFee(at(0), at(16), T).amountCents, 100); // 2 fracciones
  assert.equal(computeFee(at(0), at(60), T).amountCents, 200);
});
test('se aplica el máximo diario y se acumulan días', () => {
  assert.equal(computeFee(at(0), at(20 * 60), T).amountCents, 2000);
  assert.equal(computeFee(at(0), at(24 * 60 + 30), T).amountCents, 2000 + 100);
});
