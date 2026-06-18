import Database from "better-sqlite3";
import * as path from "node:path";
import { ensureCacheDir } from "./cache-dir";

const DB_FILE_NAME = "imod.db";

let db: Database.Database | undefined;

export function getCacheDb(): Database.Database {
  if (db)
    return db;
  const dbPath = path.join(ensureCacheDir(), DB_FILE_NAME);
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

export function closeCacheDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

function initSchema(database: Database.Database): void {
  database.exec(`
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
  `);
}
