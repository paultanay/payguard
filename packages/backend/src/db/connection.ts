import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { SCHEMA_SQL } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;

  const resolvedPath =
    dbPath ??
    process.env.DB_PATH ??
    path.join(__dirname, '../../../../data/payguard.db');

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  import('fs').then((fs) => fs.mkdirSync(dir, { recursive: true }));

  _db = new Database(resolvedPath);
  _db.exec(SCHEMA_SQL);

  // Record schema version if not set
  const versionRow = _db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
  if (!versionRow) {
    _db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
  }

  return _db;
}

/** Create an in-memory database for tests. Returns a fresh DB each call. */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

/** Close and reset the singleton (useful in tests). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
