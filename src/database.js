import 'dotenv/config';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredPath = process.env.DB_PATH || './data/exgudang.sqlite';
const databasePath = isAbsolute(configuredPath) ? configuredPath : resolve(projectRoot, configuredPath);

mkdirSync(dirname(databasePath), { recursive: true });
export const db = new Database(databasePath, { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const migrationPath = resolve(projectRoot, 'migrations/001_initial.sql');
const migration = readFileSync(migrationPath, 'utf8');
const currentVersion = Number(db.pragma('user_version', { simple: true }));

if (currentVersion < 1) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(migration);
    db.pragma('user_version = 1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const databaseInfo = {
  path: databasePath,
  version: Number(db.pragma('user_version', { simple: true }))
};

export function closeDatabase() {
  if (db.open) db.close();
}
