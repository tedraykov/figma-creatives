// SQLite storage for everything the app saves (integrations, projects, API key hashes, settings).
// One file, `creatives.db` in DATA_DIR: mount a volume there to survive redeploys.
// Uses Node's built-in node:sqlite, so there is no native dependency to build.
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve('data');
export const DB_FILE = path.join(DATA_DIR, 'creatives.db');

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
try { chmodSync(DB_FILE, 0o600); } catch { /* best effort: the file holds tokens, so keep it owner-only */ }
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',          -- credentials and type-specific fields (JSON)
    position INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, integration_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL,
    created_at TEXT NOT NULL, last_used_at TEXT, position INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
export const isEmpty = () => !count('integrations') && !count('projects') && !count('api_keys') && !count('settings');

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : undefined;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function readAll() {
  const integrations = db.prepare('SELECT * FROM integrations ORDER BY position').all()
    .map((r) => ({ id: r.id, name: r.name, type: r.type, ...JSON.parse(r.data) }));
  const projects = db.prepare('SELECT * FROM projects ORDER BY position').all()
    .map((r) => ({ id: r.id, name: r.name, integrationId: r.integration_id, source: r.source }));
  const apiKeys = db.prepare('SELECT * FROM api_keys ORDER BY position').all()
    .map((r) => ({ id: r.id, name: r.name, hash: r.hash, hint: r.hint, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  return {
    integrations, projects, apiKeys,
    defaultProjectId: getSetting('defaultProjectId') ?? '',
    hidden: getSetting('hidden') ?? [],
    renames: getSetting('renames') ?? {},
  };
}

// Writes the whole state in one transaction: it is small, and this keeps every save atomic.
export function writeAll(state) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM integrations; DELETE FROM projects; DELETE FROM api_keys;');
    const putInt = db.prepare('INSERT INTO integrations (id, name, type, data, position) VALUES (?, ?, ?, ?, ?)');
    state.integrations.forEach(({ id, name, type, ...rest }, i) => putInt.run(id, name, type, JSON.stringify(rest), i));
    const putProj = db.prepare('INSERT INTO projects (id, name, integration_id, source, position) VALUES (?, ?, ?, ?, ?)');
    state.projects.forEach((p, i) => putProj.run(p.id, p.name, p.integrationId, p.source ?? '', i));
    const putKey = db.prepare('INSERT INTO api_keys (id, name, hash, hint, created_at, last_used_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)');
    state.apiKeys.forEach((k, i) => putKey.run(k.id, k.name, k.hash, k.hint, k.createdAt, k.lastUsedAt ?? null, i));
    setSetting('defaultProjectId', state.defaultProjectId ?? '');
    setSetting('hidden', state.hidden ?? []);
    setSetting('renames', state.renames ?? {});
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
