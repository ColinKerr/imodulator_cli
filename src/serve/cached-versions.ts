import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CheckpointManager, IModelDb, SnapshotDb, SQLiteDb } from "@itwin/core-backend";
import { DbResult, OpenMode } from "@itwin/core-bentley";
import type { ChangesetIdWithIndex } from "@itwin/core-common";
import { getCacheDb } from "../cache/cache-db";

/**
 * The versions of each iModel the cache holds a file for, and opening one the way a checkpoint
 * is opened, so the standard RPC open path finds it already open and never downloads.
 *
 * `IModelReadRpcImpl.getConnectionProps` first looks for a SnapshotDb open under
 * `CheckpointManager.getKey` -- `<iModelId>:<changesetId>` -- and only downloads when there is
 * none. A cached briefcase or checkpoint opened read-only as a SnapshotDb under that key is
 * served as if it were the checkpoint.
 */

export interface CachedVersion {
  iModelId: string;
  /** Read from the file itself: the cache's tables do not always record it. */
  changeset: ChangesetIdWithIndex;
  filePath: string;
  source: "briefcase" | "checkpoint";
}

interface PeekedFile {
  mtimeMs: number;
  changeset: ChangesetIdWithIndex;
}

/** Files already peeked, so a list of versions does not reopen every file each time. */
const peeked = new Map<string, PeekedFile>();

function readLocal(db: SQLiteDb, name: string): string | undefined {
  return db.withSqliteStatement("SELECT val FROM be_Local WHERE name=?", (stmt) => {
    stmt.bindString(1, name);
    return stmt.step() === DbResult.BE_SQLITE_ROW ? stmt.getValueString(0) : undefined;
  });
}

/**
 * The changeset an iModel file is at, read from its local properties without opening it as
 * an iModel: cheap even for a file of many gigabytes.
 *
 * Files written by iTwin.js 3 and later hold the id and index together; older ones hold only
 * the id, and the index then comes from the cache's changesets table when it is known there.
 */
export function readFileChangeset(filePath: string, iModelId: string): ChangesetIdWithIndex {
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const known = peeked.get(filePath);
  if (known && known.mtimeMs === mtimeMs)
    return known.changeset;

  const db = new SQLiteDb();
  db.openDb(filePath, OpenMode.Readonly);
  let changeset: ChangesetIdWithIndex;
  try {
    const both = readLocal(db, "parentChangeset");
    if (both) {
      const parsed = JSON.parse(both) as { id?: string; index?: number };
      changeset = { id: parsed.id ?? "", index: parsed.index ?? 0 };
    } else {
      const id = readLocal(db, "ParentChangeSetId") ?? "";
      changeset = { id, index: id === "" ? 0 : changesetIndexFromCache(iModelId, id) };
    }
  } finally {
    db.closeDb();
  }
  peeked.set(filePath, { mtimeMs, changeset });
  return changeset;
}

function changesetIndexFromCache(iModelId: string, changesetId: string): number | undefined {
  const row = getCacheDb()
    .prepare("SELECT changeset_index FROM changesets WHERE imodel_id = ? AND changeset_id = ?")
    .get(iModelId, changesetId) as { changeset_index: number } | undefined;
  return row?.changeset_index;
}

/** The files the cache's tables name for an iModel, whether or not they still exist. */
function cachedFiles(iModelId: string): { filePath: string; source: CachedVersion["source"] }[] {
  const db = getCacheDb();
  const checkpoints = db
    .prepare("SELECT file_path FROM downloaded_checkpoints WHERE imodel_id = ? ORDER BY downloaded_at")
    .all(iModelId) as { file_path: string }[];
  const briefcases = db
    .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? ORDER BY briefcase_id")
    .all(iModelId) as { file_path: string }[];
  return [
    ...checkpoints.map((row) => ({ filePath: row.file_path, source: "checkpoint" as const })),
    ...briefcases.map((row) => ({ filePath: row.file_path, source: "briefcase" as const })),
  ];
}

/** Whether the cache holds any file for this iModel, without reading one. */
export function hasCachedFile(iModelId: string): boolean {
  return cachedFiles(iModelId).some((file) => fs.existsSync(file.filePath));
}

/**
 * Every version of an iModel the cache can serve, one per changeset, oldest first.
 *
 * Where a checkpoint and a briefcase are at the same changeset, the checkpoint is kept: it is
 * what the key names. A file that cannot be read is left out rather than failing the list.
 */
export function listCachedVersions(iModelId: string): CachedVersion[] {
  const byChangeset = new Map<string, CachedVersion>();
  for (const file of cachedFiles(iModelId)) {
    if (!fs.existsSync(file.filePath))
      continue;
    let changeset: ChangesetIdWithIndex;
    try {
      changeset = readFileChangeset(file.filePath, iModelId);
    } catch {
      continue;
    }
    if (!byChangeset.has(changeset.id))
      byChangeset.set(changeset.id, { iModelId, changeset, filePath: file.filePath, source: file.source });
  }
  return [...byChangeset.values()].sort((a, b) => (a.changeset.index ?? 0) - (b.changeset.index ?? 0));
}

/** The version the cache serves as the iModel's latest: the one at the highest changeset. */
export function latestCachedVersion(iModelId: string): CachedVersion | undefined {
  return listCachedVersions(iModelId).at(-1);
}

/** The key the standard RPC open path looks a checkpoint up by. */
export function checkpointKey(iModelId: string, changesetId: string): string {
  // The iTwin plays no part in the key.
  return CheckpointManager.getKey({ iTwinId: "", iModelId, changeset: { id: changesetId } });
}

/**
 * Where the native library puts the files it makes beside an open iModel -- the tile cache
 * above all. By default that is next to the iModel, inside imodulator's cache; serving a
 * cached file must not add to the cache, so they go to the system's temporary directory.
 */
function tempFileBase(key: string): string {
  const dir = path.join(os.tmpdir(), "imod-serve");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, key.replace(/[^0-9A-Za-z-]/g, "_"));
}

export interface OpenedVersion {
  key: string;
  /** Undefined when it was already open under the key. */
  version?: CachedVersion;
  db: IModelDb;
  /** False when it was already open under the key. */
  opened: boolean;
}

/**
 * Open the cached file at an iModel's changeset under the checkpoint key, or return it if it
 * is already open. Undefined when the cache holds no file at that changeset.
 *
 * Read-only, as a SnapshotDb whatever the file was downloaded as: the lookup the RPC open
 * path makes (`SnapshotDb.tryFindByKey`) finds nothing else.
 */
export function openCachedVersion(iModelId: string, changesetId: string): OpenedVersion | undefined {
  const key = checkpointKey(iModelId, changesetId);
  const existing = IModelDb.tryFindByKey(key);
  if (existing)
    return { key, db: existing, opened: false };
  const version = listCachedVersions(iModelId).find((candidate) => candidate.changeset.id === changesetId);
  if (!version)
    return undefined;
  const db = SnapshotDb.openFile(version.filePath, { key, tempFileBase: tempFileBase(key) });
  return { key, version, db, opened: true };
}
