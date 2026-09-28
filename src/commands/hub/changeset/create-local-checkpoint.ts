import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import * as path from "node:path";
import { SnapshotDb } from "@itwin/core-backend";
import { BriefcaseIdValue } from "@itwin/core-common";
import { _nativeDb } from "@itwin/core-backend/lib/cjs/internal/Symbols.js";
import { startIModelHost } from "../../../host/imodel-host";
import { getCacheDb } from "../../../cache/cache-db";
import { ensureIModelCacheDir } from "../../../cache/cache-dir";
import { changesetIndexForId, listCachedChangesets } from "../../../cache/changesets";
import { applyCachedChangesets, currentChangesetIndex } from "../../../changeset/apply";

export interface CreateLocalCheckpointArgs {
  imodelId: string;
  changesetId?: string;
  changesetIndex?: number;
  /** Where to write the checkpoint. Defaults into the cache's checkpoints directory. */
  outputPath?: string;
  /** Start from this file instead of the best one the cache holds. */
  basePath?: string;
}

export interface CreateLocalCheckpointResult {
  filePath: string;
  baseIndex: number;
  changesetIndex: number;
  applied: number;
}

/** A local file the cache holds for this iModel, and the changeset it sits at. */
interface BaseCandidate {
  filePath: string;
  index: number;
}

/**
 * The best file to start from: the one closest to the target without being past it.
 *
 * Both checkpoints and briefcases are candidates -- either is a valid starting point, since
 * what makes the result a checkpoint is resetting the briefcase id, not where it came from.
 */
export function findBase(imodelId: string, targetIndex: number): BaseCandidate | undefined {
  const db = getCacheDb();
  const rows = [
    ...(db
      .prepare("SELECT file_path, changeset_id FROM downloaded_checkpoints WHERE imodel_id = ?")
      .all(imodelId) as { file_path: string; changeset_id: string }[]),
    ...(db
      .prepare("SELECT file_path, changeset_id FROM downloaded_briefcases WHERE imodel_id = ? AND changeset_id IS NOT NULL")
      .all(imodelId) as { file_path: string; changeset_id: string }[]),
  ];

  let best: BaseCandidate | undefined;
  for (const row of rows) {
    if (!fs.existsSync(row.file_path))
      continue;
    // An empty changeset id is the state before any changeset, which is index 0.
    const index = row.changeset_id === "" ? 0 : changesetIndexForId(imodelId, row.changeset_id);
    if (index === undefined || index > targetIndex)
      continue;
    if (!best || index > best.index)
      best = { filePath: row.file_path, index };
  }
  return best;
}

/**
 * Build a checkpoint file at a given changeset by applying cached changesets to a copy of an
 * earlier file.
 *
 * The recipe is the one iTwin.js uses for the same job in
 * `CheckpointManager.updateToRequestedVersion`: drop any local txns, reset the briefcase id to
 * Unassigned, then apply forward. The difference is where the changesets come from -- the
 * cache, rather than a download that deletes them afterwards.
 */
export async function runCreateLocalCheckpoint(
  args: CreateLocalCheckpointArgs,
): Promise<CreateLocalCheckpointResult> {
  if (args.changesetId === undefined && args.changesetIndex === undefined)
    throw new Error("Provide --changeset-id or --changeset-index");

  await startIModelHost();

  const targetIndex = args.changesetIndex ?? resolveIndex(args.imodelId, args.changesetId!);
  const target = listCachedChangesets(args.imodelId, { start: targetIndex, end: targetIndex })[0];
  if (!target)
    throw new Error(
      `Changeset index ${targetIndex} is not in the cache for iModel ${args.imodelId}. Run "imod hub changeset download metadata --imodel-id ${args.imodelId}".`,
    );

  const base = args.basePath
    ? { filePath: args.basePath, index: -1 }
    : findBase(args.imodelId, targetIndex);
  if (!base)
    throw new Error(
      `No local file for iModel ${args.imodelId} at or before changeset ${targetIndex} to start from. Download a checkpoint or briefcase first, or pass --base-path.`,
    );

  const filePath = args.outputPath
    ?? path.join(ensureIModelCacheDir(args.imodelId), "checkpoints", `${args.imodelId}_${target.id}.bim`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath))
    throw new Error(`${filePath} already exists. Delete it, or pass a different --output-path.`);

  console.log(`Starting from ${base.filePath}`);
  fs.copyFileSync(base.filePath, filePath);

  // Opened inside the try, not before it: a base that turns out not to be an iModel throws
  // here, and the copy has to be cleaned up just as a failure part way through applying does.
  let db: SnapshotDb | undefined;
  try {
    db = SnapshotDb.openForApplyChangesets(filePath);
    const nativeDb = db[_nativeDb];
    // A checkpoint carries no local work and belongs to no briefcase.
    if (nativeDb.hasPendingTxns())
      nativeDb.deleteAllTxns();
    if (nativeDb.getBriefcaseId() !== BriefcaseIdValue.Unassigned)
      nativeDb.resetBriefcaseId(BriefcaseIdValue.Unassigned);

    const baseIndex = currentChangesetIndex(db);
    const result = applyCachedChangesets({
      db,
      imodelId: args.imodelId,
      targetIndex,
      onApplied: (changeset, applied, total) =>
        console.log(`Applied ${applied}/${total}: index ${changeset.index} ${changeset.id}`),
    });
    nativeDb.saveChanges();
    db.close();

    getCacheDb()
      .prepare("INSERT OR REPLACE INTO downloaded_checkpoints (imodel_id, changeset_id, file_path) VALUES (?, ?, ?)")
      .run(args.imodelId, target.id, filePath);

    return { filePath, baseIndex, changesetIndex: result.toIndex, applied: result.applied };
  } catch (err) {
    // A half-built checkpoint is worse than none: it looks like a valid file at the wrong
    // changeset, and nothing about it says so. Remove it rather than leave it to be found later.
    if (db?.isOpen)
      db.close();
    fs.rmSync(filePath, { force: true });
    throw err;
  }
}

function resolveIndex(imodelId: string, changesetId: string): number {
  const index = changesetIndexForId(imodelId, changesetId);
  if (index === undefined)
    throw new Error(
      `Changeset ${changesetId} is not in the cache for iModel ${imodelId}. Run "imod hub changeset download metadata --imodel-id ${imodelId}".`,
    );
  return index;
}

export const createLocalCheckpointCommand: CommandModule<unknown, CreateLocalCheckpointArgs> = {
  command: "create-local-checkpoint",
  describe: "Create a checkpoint file at a changeset by applying cached changesets to an earlier file",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("changeset-id", { type: "string", describe: "The changeset the checkpoint should be at" })
      .option("changeset-index", { type: "number", describe: "The changeset index the checkpoint should be at" })
      .option("output-path", { type: "string", describe: "Where to write the checkpoint. Defaults into the cache" })
      .option("base-path", { type: "string", describe: "Start from this file instead of the best one in the cache" }) as never,
  handler: async (argv) => {
    const result = await runCreateLocalCheckpoint({
      imodelId: argv.imodelId,
      changesetId: argv.changesetId,
      changesetIndex: argv.changesetIndex,
      outputPath: argv.outputPath,
      basePath: argv.basePath,
    });
    console.log(
      `Created a checkpoint at changeset index ${result.changesetIndex} by applying ${result.applied} changeset(s) from index ${result.baseIndex}.`,
    );
    console.log(result.filePath);
  },
};
