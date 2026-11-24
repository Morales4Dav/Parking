// Persistencia en SQLite usando el módulo nativo node:sqlite (sin dependencias).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Dispositivos físicos (cámaras LPR, controladoras de barrera, relés...)
CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  driver     TEXT NOT NULL,              -- hikvision | dahua | milesight | generic-http | simulator
  host       TEXT,
  port       INTEGER,
  username   TEXT,
  password   TEXT,
  channel    INTEGER DEFAULT 1,
  options    TEXT DEFAULT '{}',          -- JSON con opciones específicas del driver
  enabled    INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Carriles: asocian una cámara (lectura) y un actuador (barrera) con un sentido.
CREATE TABLE IF NOT EXISTS lanes (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('entry','exit')),
  camera_device_id  TEXT REFERENCES devices(id) ON DELETE SET NULL,
  barrier_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  zone_id           TEXT REFERENCES zones(id) ON DELETE SET NULL,
  enabled           INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS zones (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 100
);

-- Vehículos conocidos: abonados, lista blanca, lista negra.
CREATE TABLE IF NOT EXISTS vehicles (
  plate       TEXT PRIMARY KEY,
  owner       TEXT,
  category    TEXT NOT NULL DEFAULT 'subscriber' CHECK (category IN ('subscriber','whitelist','blacklist')),
  valid_from  TEXT,
  valid_to    TEXT,
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Estancias (una por entrada).
CREATE TABLE IF NOT EXISTS stays (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plate         TEXT NOT NULL,
  zone_id       TEXT,
  entry_lane_id TEXT,
  exit_lane_id  TEXT,
  entry_at      TEXT NOT NULL,
  exit_at       TEXT,
  category      TEXT NOT NULL DEFAULT 'visitor',
  amount_cents  INTEGER,
  paid_cents    INTEGER DEFAULT 0,
  paid_at       TEXT,
  status        TEXT NOT NULL DEFAULT 'inside' CHECK (status IN ('inside','closed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_stays_plate_status ON stays(plate, status);

-- Registro de eventos / auditoría.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type       TEXT NOT NULL,
  plate      TEXT,
  lane_id    TEXT,
  device_id  TEXT,
  decision   TEXT,
  reason     TEXT,
  data       TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

const DEFAULT_SETTINGS = {
  tariff: {
    currency: 'EUR',
    graceMinutes: 15,          // minutos gratis
    blockMinutes: 15,          // fracción de cobro
    pricePerBlockCents: 50,    // precio por fracción
    dailyCapCents: 2000,       // máximo por cada 24 h
    exitGraceMinutes: 15       // tiempo para salir tras pagar
  },
  access: {
    allowVisitors: true,       // permitir entrada a vehículos no registrados
    openOnUnpaidExit: false,   // abrir salida aunque haya importe pendiente
    duplicateReadSeconds: 10   // ignorar lecturas repetidas de la misma matrícula en el mismo carril
  }
};

export function openDb(file = process.env.PARKING_DB || 'data/parking.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, JSON.stringify(v));
  return db;
}

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : DEFAULT_SETTINGS[key];
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

/** Normaliza matrículas: mayúsculas, sin espacios ni guiones. */
export function normalizePlate(p) {
  return String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
