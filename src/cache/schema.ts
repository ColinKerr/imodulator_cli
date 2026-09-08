import type Database from "better-sqlite3";

/**
 * The cache database's schema, and how a cache made by an older build is brought up to it.
 *
 * `plan/CACHE.md` carries the same definition in prose; the two change together.
 */

/** The version this build creates and expects. */
export const CACHE_SCHEMA_VERSION = 2;

/** Where the version lives. Its *absence* means the original, unversioned schema. */
const VERSION_TABLE = "schema_version";

/** A table from version 1, used to tell an original cache from an empty file. */
const ORIGINAL_TABLE = "downloaded_briefcases";

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

/**
 * Each step from the previous version to this one, applied in order.
 *
 * A migration is never edited once it has shipped: a cache in the wild has already run it, so
 * changing it changes nothing there and only makes the two disagree. Corrections go in a new
 * version.
 */
const MIGRATIONS: Migration[] = [
  {
    // The original schema, as created by every build before versioning existed.
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS briefcase_ids (
          imodel_id TEXT NOT NULL,
          briefcase_id INTEGER NOT NULL,
          acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (imodel_id, briefcase_id)
        );

        CREATE TABLE IF NOT EXISTS downloaded_briefcases (
          imodel_id TEXT NOT NULL,
          briefcase_id INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          changeset_id TEXT,
          downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (imodel_id, briefcase_id)
        );

        CREATE TABLE IF NOT EXISTS downloaded_checkpoints (
          imodel_id TEXT NOT NULL,
          changeset_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (imodel_id, changeset_id)
        );

        CREATE TABLE IF NOT EXISTS downloaded_manifests (
          imodel_id TEXT NOT NULL PRIMARY KEY,
          file_path TEXT NOT NULL,
          etag TEXT,
          downloaded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    // What the iModels API knows about each iModel, so the cache can name what it holds and
    // answer which iTwin an iModel belongs to.
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS imodels (
          imodel_id TEXT NOT NULL PRIMARY KEY,
          itwin_id TEXT NOT NULL,
          name TEXT NOT NULL,
          display_name TEXT,
          description TEXT
        );

        CREATE INDEX IF NOT EXISTS ix_imodels_itwin ON imodels (itwin_id);
      `);
    },
  },
];

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined;
}

/**
 * What version this database is at or undefined if not a cache db.
 */
export function readSchemaVersion(db: Database.Database): number | undefined {
  if (tableExists(db, VERSION_TABLE)) {
    const row = db.prepare(`SELECT version FROM ${VERSION_TABLE}`).get() as { version: number } | undefined;
    if (row)
      return row.version;
  }
  return tableExists(db, ORIGINAL_TABLE) ? 1 : undefined;
}

/**
 * Create or upgrade the cache database in place.
 *
 * Each version is applied in its own immediate transaction so updates are atomic.
 */
export function migrateCacheDb(db: Database.Database): { from: number | undefined; to: number } {
  const from = readSchemaVersion(db);
  if (from !== undefined && from > CACHE_SCHEMA_VERSION)
    throw new Error(
      `This cache was made by a newer imod: its schema is version ${from}, and this build knows version ${CACHE_SCHEMA_VERSION}. Update imod.`,
    );

  for (const migration of MIGRATIONS) {
    if (from !== undefined && migration.version <= from)
      continue;
    db.transaction(() => {
      migration.up(db);
      stampVersion(db, migration.version);
    }).immediate();
  }

  return { from, to: CACHE_SCHEMA_VERSION };
}

function stampVersion(db: Database.Database, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (version INTEGER NOT NULL)`);
  db.prepare(`DELETE FROM ${VERSION_TABLE}`).run();
  db.prepare(`INSERT INTO ${VERSION_TABLE} (version) VALUES (?)`).run(version);
}
