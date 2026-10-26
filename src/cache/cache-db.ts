import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureCacheDir } from "./cache-dir";
import { migrateCacheDb } from "./schema";

const DB_FILE_NAME = "imod.db";

let db: Database.Database | undefined;

/**
 * Refuse to open the developer's real cache from a test run.
 *
 * Keyed on `VITEST`, which vitest sets in every worker regardless of how it was invoked.
 */
function assertNotTheRealCacheUnderTest(dbPath: string): void {
  if (!process.env.VITEST)
    return;

  const real = fs.realpathSync(path.dirname(dbPath));
  const temp = fs.realpathSync(os.tmpdir());
  if (real.startsWith(temp))
    return;

  throw new Error(
    `Refusing to open ${dbPath} from a test run: it is not under ${temp}.\n`
    + `Tests must use an isolated cache. IMOD_CACHE_DIR is `
    + `${process.env.IMOD_CACHE_DIR ? `"${process.env.IMOD_CACHE_DIR}"` : "not set"}, which means `
    + `src/test/temp-workspace.ts did not run -- usually because vitest was invoked without the `
    + `project config. Run tests with "npx vitest run", not with --config overridden.`,
  );
}

export function getCacheDb(): Database.Database {
  if (db)
    return db;
  const dbPath = path.join(ensureCacheDir(), DB_FILE_NAME);
  assertNotTheRealCacheUnderTest(dbPath);
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
