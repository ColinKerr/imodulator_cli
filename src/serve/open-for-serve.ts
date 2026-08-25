import * as fs from "node:fs";
import { BriefcaseDb, IModelDb, SnapshotDb } from "@itwin/core-backend";
import { getCacheDb } from "../cache/cache-db";

/** The key the iModel supplied by `--imodel-path` is registered under. */
export const DEFAULT_KEY = "default";

/**
 * A key naming a briefcase in the cache: `<imodelId>/<briefcaseId>`, the briefcase id being
 * all digits. A checkpoint uses `<imodelId>/<changesetId>` and is told apart by that.
 */
const BRIEFCASE_KEY = /^([0-9a-fA-F-]{36})\/(\d+)$/;
const CHECKPOINT_KEY = /^([0-9a-fA-F-]{36})\/([0-9a-fA-F]+)$/;

/** How a key was understood, so the server can report what it opened. */
export type KeySource = "path" | "briefcase" | "checkpoint";

export interface ResolvedIModel {
  filePath: string;
  source: KeySource;
}

/**
 * Turn a key into the file it names.
 *
 * A key is either a path to an iModel or a reference to one already in the cache. Paths are
 * tried first: a caller who passes a real path always gets that file, whatever it looks like.
 */
export function resolveIModelKey(key: string): ResolvedIModel {
  if (fs.existsSync(key))
    return { filePath: key, source: "path" };

  const briefcase = BRIEFCASE_KEY.exec(key);
  if (briefcase) {
    const row = getCacheDb()
      .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
      .get(briefcase[1], Number(briefcase[2])) as { file_path: string } | undefined;
    if (row)
      return { filePath: row.file_path, source: "briefcase" };
  }

  const checkpoint = CHECKPOINT_KEY.exec(key);
  if (checkpoint) {
    const row = getCacheDb()
      .prepare("SELECT file_path FROM downloaded_checkpoints WHERE imodel_id = ? AND changeset_id = ?")
      .get(checkpoint[1], checkpoint[2]) as { file_path: string } | undefined;
    if (row)
      return { filePath: row.file_path, source: "checkpoint" };
  }

  throw new Error(
    `No iModel found for "${key}". Pass a path to an iModel file, or <imodelId>/<briefcaseId> or <imodelId>/<changesetId> for one in the cache.`,
  );
}

/**
 * Open an iModel read-only under exactly the key given.
 *
 * The key is used verbatim, never decorated, because that is what the client sends back on
 * every later RPC call and what `IModelDb.findByKey` matches against.
 *
 * Checkpoints open as snapshots; briefcases do not, and fall back to a read-only briefcase
 * open. Read-only throughout: this server exists to look at iModels, not to edit them.
 */
export async function openForServe(filePath: string, key: string): Promise<IModelDb> {
  if (!fs.existsSync(filePath))
    throw new Error(`iModel file not found: ${filePath}`);

  try {
    return SnapshotDb.openFile(filePath, { key });
  } catch (snapshotError) {
    try {
      return await BriefcaseDb.open({ fileName: filePath, key, readonly: true });
    } catch {
      throw snapshotError;
    }
  }
}

export interface OpenedIModel {
  key: string;
  filePath: string;
  source: KeySource;
  /** False when the key was already open and the existing connection was reused. */
  opened: boolean;
  db: IModelDb;
}

/**
 * Open the iModel a key names, or return the one already open under it.
 *
 * `tryFindByKey` is what makes this idempotent: a second request for the same key reuses the
 * open iModel rather than opening the file twice.
 */
export async function openOrReuse(key: string): Promise<OpenedIModel> {
  const existing = IModelDb.tryFindByKey(key);
  if (existing)
    return { key, filePath: existing.pathName, source: "path", opened: false, db: existing };

  const { filePath, source } = resolveIModelKey(key);
  return { key, filePath, source, opened: true, db: await openForServe(filePath, key) };
}

export interface CacheIModel {
  /** The key to pass to the open endpoint. */
  key: string;
  filePath: string;
  source: Exclude<KeySource, "path">;
  imodelId: string;
  /** Briefcase id or changeset id, depending on the source. */
  version: string;
}

/** The iModels in the imodulator cache, as keys a client can open. */
export function listCacheIModels(): CacheIModel[] {
  const db = getCacheDb();
  const briefcases = db
    .prepare("SELECT imodel_id, briefcase_id, file_path FROM downloaded_briefcases ORDER BY imodel_id, briefcase_id")
    .all() as { imodel_id: string; briefcase_id: number; file_path: string }[];
  const checkpoints = db
    .prepare("SELECT imodel_id, changeset_id, file_path FROM downloaded_checkpoints ORDER BY imodel_id")
    .all() as { imodel_id: string; changeset_id: string; file_path: string }[];

  return [
    ...briefcases.map((row) => ({
      key: `${row.imodel_id}/${row.briefcase_id}`,
      filePath: row.file_path,
      source: "briefcase" as const,
      imodelId: row.imodel_id,
      version: String(row.briefcase_id),
    })),
    ...checkpoints.map((row) => ({
      key: `${row.imodel_id}/${row.changeset_id}`,
      filePath: row.file_path,
      source: "checkpoint" as const,
      imodelId: row.imodel_id,
      version: row.changeset_id,
    })),
  ];
}
