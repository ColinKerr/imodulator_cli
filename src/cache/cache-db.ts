import Database from "better-sqlite3";
import * as path from "node:path";
import { ensureCacheDir } from "./cache-dir";
import { migrateCacheDb } from "./schema";

const DB_FILE_NAME = "imod.db";

let db: Database.Database | undefined;

export function getCacheDb(): Database.Database {
  if (db)
    return db;
  const dbPath = path.join(ensureCacheDir(), DB_FILE_NAME);
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // Creates the schema in a new file and upgrades an older one, both in place.
  migrateCacheDb(db);
  return db;
}

export function closeCacheDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
