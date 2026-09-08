import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_SCHEMA_VERSION, migrateCacheDb, readSchemaVersion } from "../../cache/schema";
import { testTempDir } from "../temp-workspace";

const FIXTURE_DIR = join(__dirname, "fixtures");

/** A database built from one of the historical schema fixtures. */
function fixtureDb(version: number): Database.Database {
  const db = new Database(join(testTempDir(`cache-v${version}`), "imod.db"));
  db.exec(readFileSync(join(FIXTURE_DIR, `v${version}.sql`), "utf8"));
  return db;
}

function emptyDb(name: string): Database.Database {
  return new Database(join(testTempDir(name), "imod.db"));
}

/** Tables and indexes, so two databases can be compared by shape rather than by DDL text. */
function shape(db: Database.Database): string[] {
  const objects = db
    .prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all() as { type: string; name: string }[];
  return objects.map((o) => {
    const columns = o.type === "table"
      ? (db.prepare(`PRAGMA table_info("${o.name}")`).all() as { name: string }[]).map((c) => c.name).join(",")
      : "";
    return `${o.type} ${o.name}${columns ? ` (${columns})` : ""}`;
  });
}

/** Every fixture on disk, so a new version without a fixture fails this suite. */
const fixtureVersions = readdirSync(FIXTURE_DIR)
  .map((file) => /^v(\d+)\.sql$/.exec(file)?.[1])
  .filter((v): v is string => v !== undefined)
  .map(Number)
  .sort((a, b) => a - b);

describe("cache schema versions", () => {
  it("has a fixture for every version up to the current one", () => {
    // The fixtures are what prove old caches still upgrade. A version without one is a hole.
    expect(fixtureVersions).toEqual(
      Array.from({ length: CACHE_SCHEMA_VERSION }, (_, i) => i + 1),
    );
  });

  it("reads no version from an empty file, which has no schema at all", () => {
    const db = emptyDb("empty");
    expect(readSchemaVersion(db)).toBeUndefined();
    db.close();
  });

  it("reads the original schema as version 1 from the absence of a stamp", () => {
    const db = fixtureDb(1);
    expect(readSchemaVersion(db)).toBe(1);
    db.close();
  });

  it("reads a stamped version from the stamp", () => {
    const db = fixtureDb(2);
    expect(readSchemaVersion(db)).toBe(2);
    db.close();
  });
});

describe("migrateCacheDb", () => {
  it("creates the current schema in an empty file", () => {
    const db = emptyDb("create");
    migrateCacheDb(db);
    expect(readSchemaVersion(db)).toBe(CACHE_SCHEMA_VERSION);
    db.close();
  });

  it.each(fixtureVersions)("upgrades a version %i cache to the current schema", (version) => {
    const old = fixtureDb(version);
    migrateCacheDb(old);

    const fresh = emptyDb(`fresh-from-${version}`);
    migrateCacheDb(fresh);

    // An upgraded cache is indistinguishable from one created new at this version.
    expect(shape(old)).toEqual(shape(fresh));
    expect(readSchemaVersion(old)).toBe(CACHE_SCHEMA_VERSION);
    old.close();
    fresh.close();
  });

  it("keeps the rows a cache already held", () => {
    const db = fixtureDb(1);
    db.prepare(
      "INSERT INTO downloaded_briefcases (imodel_id, briefcase_id, file_path, changeset_id) VALUES (?,?,?,?)",
    ).run("imodel-a", 2, "/tmp/2.bim", "cs1");
    db.prepare("INSERT INTO briefcase_ids (imodel_id, briefcase_id) VALUES (?,?)").run("imodel-a", 2);

    migrateCacheDb(db);

    const row = db
      .prepare("SELECT file_path, changeset_id FROM downloaded_briefcases WHERE imodel_id=?")
      .get("imodel-a");
    expect(row).toEqual({ file_path: "/tmp/2.bim", changeset_id: "cs1" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefcase_ids").get()).toEqual({ n: 1 });
    db.close();
  });

  it("is idempotent: migrating an up to date cache changes nothing", () => {
    const db = emptyDb("idempotent");
    migrateCacheDb(db);
    const before = shape(db);

    migrateCacheDb(db);
    migrateCacheDb(db);

    expect(shape(db)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_version").get()).toEqual({ n: 1 });
    db.close();
  });

  it("leaves the version and the schema untouched when a migration fails", () => {
    const db = fixtureDb(1);
    // Occupy the name the v2 migration needs for its index, so its CREATE INDEX throws part
    // way through -- after the imodels table has been created within the same transaction.
    db.exec("CREATE TABLE ix_imodels_itwin (x TEXT)");

    expect(() => migrateCacheDb(db)).toThrow();

    // Rolled back whole: no half-applied table, and still reporting the version it was.
    expect(shape(db).some((o) => o.startsWith("table imodels"))).toBe(false);
    expect(readSchemaVersion(db)).toBe(1);
    db.close();
  });

  it("refuses a cache written by a newer build", () => {
    const db = emptyDb("from-the-future");
    migrateCacheDb(db);
    db.prepare("UPDATE schema_version SET version = ?").run(CACHE_SCHEMA_VERSION + 1);

    expect(() => migrateCacheDb(db)).toThrow(/newer imod/);
    db.close();
  });

  it("reports where it came from and where it got to", () => {
    const db = fixtureDb(1);
    expect(migrateCacheDb(db)).toEqual({ from: 1, to: CACHE_SCHEMA_VERSION });
    db.close();
  });
});
