/**
 * Versioned SQLite schema (Plan B9). Every version is keyed to `RELEASE.saveSchema`; a file whose
 * recorded version is newer than this build is never touched, and an older one is backed up with
 * `VACUUM INTO` before migrating — a raw copy of a live database without its WAL is not a backup.
 *
 * The table names are the ones Plan B9 names. `mission_attempts` and `sectors` exist from the first
 * version so the campaign graph can materialize a space and record an attempt without a schema
 * migration; nothing in the port fabricates rows for them.
 */

import type { Database } from 'bun:sqlite';
import { RELEASE } from '../../shared/contracts.ts';

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

export const SCHEMA_VERSION = RELEASE.saveSchema;

const V1: readonly string[] = [
  `CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    credits INTEGER NOT NULL,
    inventory_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_saved_at TEXT
  )`,
  `CREATE TABLE checkpoints (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    checkpoint_id TEXT NOT NULL,
    tick INTEGER NOT NULL,
    at TEXT NOT NULL,
    state TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (campaign_id, checkpoint_id)
  )`,
  `CREATE TABLE module_instances (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    instance_id TEXT NOT NULL,
    part_id TEXT NOT NULL,
    health REAL NOT NULL,
    reserved_by_pilot_id TEXT,
    PRIMARY KEY (campaign_id, instance_id)
  )`,
];

const V2: readonly string[] = [
  'CREATE INDEX checkpoints_by_tick ON checkpoints (campaign_id, tick DESC)',
  `CREATE TABLE pilots (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    pilot_id TEXT NOT NULL,
    credential_hash TEXT,
    remember_device INTEGER NOT NULL DEFAULT 0,
    enrolled_at TEXT NOT NULL,
    PRIMARY KEY (campaign_id, pilot_id)
  )`,
  `CREATE TABLE fit_reservations (
    instance_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    pilot_id TEXT NOT NULL,
    slot_id TEXT,
    reserved_at TEXT NOT NULL
  )`,
  `CREATE TABLE sectors (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    sector_id TEXT NOT NULL,
    baseline_revision INTEGER NOT NULL,
    content_version TEXT NOT NULL,
    materialized_at TEXT NOT NULL,
    settled_at TEXT,
    PRIMARY KEY (campaign_id, sector_id)
  )`,
  `CREATE TABLE mission_attempts (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    mission_id TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    settled_at TEXT,
    PRIMARY KEY (campaign_id, attempt_id)
  )`,
  `CREATE TABLE objective_receipts (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    objective_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    PRIMARY KEY (campaign_id, objective_id, item_id)
  )`,
  `CREATE TABLE reward_receipts (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    result_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    credits INTEGER NOT NULL,
    paid_at TEXT NOT NULL,
    PRIMARY KEY (campaign_id, result_id)
  )`,
  `CREATE TABLE decisions (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    decision_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY (campaign_id, decision_id)
  )`,
  `CREATE TABLE settlements (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    result_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    credits INTEGER NOT NULL,
    reward_credits INTEGER NOT NULL,
    repair_credits INTEGER NOT NULL,
    settled_at TEXT NOT NULL,
    PRIMARY KEY (campaign_id, result_id)
  )`,
];

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'campaign-core', statements: V1 },
  { version: 2, name: 'campaign-receipts', statements: V2 },
];

/** Applied version, or 0 for a database that has never carried the drift schema. */
export function readSchemaVersion(db: Database): number {
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return 0;
  const row = db.query('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null } | null;
  return row?.version ?? 0;
}

export function integrityCheck(db: Database): string {
  const rows = db.query('PRAGMA integrity_check').all() as { integrity_check: string }[];
  return rows.map(row => row.integrity_check).join(', ');
}

/**
 * Apply every migration newer than `upTo` (inclusive) in one transaction each, so a failure leaves
 * the recorded version matching the schema that is actually there.
 */
export function applyMigrations(db: Database, upTo: number = SCHEMA_VERSION): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = readSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= applied || migration.version > upTo) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
  }
}

/**
 * SQLite-safe backup: `VACUUM INTO` writes a consistent copy through the engine, unlike a file copy
 * that can miss the WAL. Returns the backup path.
 */
export function backupDatabase(db: Database, backupPath: string): string {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  return backupPath;
}
