// Datos de demostración: un parking con dos carriles simulados.
export function seedDemo(db) {
  const tx = [
    ["INSERT OR IGNORE INTO zones(id, name, capacity) VALUES ('P1', 'Planta 1', 50)"],
    ["INSERT OR IGNORE INTO devices(id, name, driver, options) VALUES ('cam-in', 'Cámara entrada (simulada)', 'simulator', '{}')"],
    ["INSERT OR IGNORE INTO devices(id, name, driver, options) VALUES ('cam-out', 'Cámara salida (simulada)', 'simulator', '{}')"],
    ["INSERT OR IGNORE INTO lanes(id, name, direction, camera_device_id, zone_id) VALUES ('E1', 'Entrada principal', 'entry', 'cam-in', 'P1')"],
    ["INSERT OR IGNORE INTO lanes(id, name, direction, camera_device_id, zone_id) VALUES ('S1', 'Salida principal', 'exit', 'cam-out', 'P1')"],
    ["INSERT OR IGNORE INTO vehicles(plate, owner, category, valid_to) VALUES ('1234ABC', 'Abonado demo', 'subscriber', '2099-12-31')"],
    ["INSERT OR IGNORE INTO vehicles(plate, owner, category, notes) VALUES ('6666XXX', NULL, 'blacklist', 'Impago')"]
  ];
  for (const [sql] of tx) db.exec(sql);
  console.log('Datos de demostración cargados (dispositivos simulados E1/S1).');
}
