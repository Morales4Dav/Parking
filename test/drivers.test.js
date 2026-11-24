import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDriver } from '../src/drivers/index.js';
import { buildDigestHeader } from '../src/lib/http-client.js';

const parse = (driver, body, query = {}, options = {}) =>
  createDriver({ id: 'd', name: 'd', driver, options }).parseEvent({ body: Buffer.from(body), query });

test('Hikvision: XML ANPR dentro de multipart', () => {
  const body = `--boundary\r\nContent-Disposition: form-data; name="anpr.xml"\r\nContent-Type: application/xml\r\n\r\n
<EventNotificationAlert version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<dateTime>2026-03-01T08:00:00+01:00</dateTime><eventType>ANPR</eventType>
<ANPR><licensePlate>1234ABC</licensePlate><confidenceLevel>98</confidenceLevel><direction>forward</direction></ANPR>
</EventNotificationAlert>\r\n--boundary--`;
  const [r] = parse('hikvision', body);
  assert.equal(r.plate, '1234ABC');
  assert.equal(r.confidence, 98);
  assert.equal(r.direction, 'entry');
});
test('Hikvision: ignora otros eventos y matrículas desconocidas', () => {
  assert.deepEqual(parse('hikvision', '<EventNotificationAlert><eventType>videoloss</eventType></EventNotificationAlert>'), []);
  assert.deepEqual(parse('hikvision', '<EventNotificationAlert><eventType>ANPR</eventType><licensePlate>unknown</licensePlate></EventNotificationAlert>'), []);
});
test('Dahua: JSON de tráfico con PlateNumber anidado', () => {
  const [r] = parse('dahua', JSON.stringify({ Events: [{ Code: 'TrafficJunction', Data: { TrafficCar: { PlateNumber: '5678DEF', Confidence: 90 } } }] }));
  assert.equal(r.plate, '5678DEF');
});
test('Milesight: JSON HTTP Post', () => {
  const [r] = parse('milesight', JSON.stringify({ plate: '9012GHI', confidence: '0.93', direction: 'Approach' }));
  assert.equal(r.plate, '9012GHI');
  assert.equal(r.direction, 'entry');
});
test('Genérico: campo configurable y query string', () => {
  assert.equal(parse('generic-http', JSON.stringify({ lpr: { matricula: 'AB12' } }), {}, { plateField: 'matricula' })[0].plate, 'AB12');
  assert.equal(parse('generic-http', '', { plate: 'CD34' })[0].plate, 'CD34');
});
test('Digest: respuesta RFC 2617 (ejemplo oficial)', () => {
  const h = buildDigestHeader({
    username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: '0a4f113b',
    challenge: { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth,auth-int', opaque: '5ccc069c403ebaf9f0171e9517f40e41' }
  });
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
});
