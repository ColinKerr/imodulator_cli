import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { SnapshotDb } from "@itwin/core-backend";
import { startIModelHost } from "../../../host/imodel-host";
import { applyCachedChangesets, currentChangesetIndex } from "../../../changeset/apply";
import { changesetIndexForId } from "../../../cache/changesets";

export interface ApplyChangesetArgs {
  imodelPath: string;
  changesetId?: string;
  changesetIndex?: number;
  /** The iModel the cached changesets belong to. Read from the file when not given. */
  imodelId?: string;
}

export interface ApplyChangesetResult {
  imodelPath: string;
  fromIndex: number;
  toIndex: number;
  applied: number;
}

/**
 * Apply cached changesets to a local iModel, up to a target changeset.
 *
 * The iModel is opened read-write with `SnapshotDb.openForApplyChangesets`, which is the open
 * that permits applying; the ordinary snapshot open is read-only.
 */
export async function runApplyChangesets(args: ApplyChangesetArgs): Promise<ApplyChangesetResult> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);
  if (args.changesetId === undefined && args.changesetIndex === undefined)
    throw new Error("Provide --changeset-id or --changeset-index");

  await startIModelHost();

  const db = SnapshotDb.openForApplyChangesets(args.imodelPath);
  try {
    const imodelId = args.imodelId ?? db.iModelId;
    const targetIndex = args.changesetIndex ?? resolveIndex(imodelId, args.changesetId!);

    const result = applyCachedChangesets({
      db,
      imodelId,
      targetIndex,
      onApplied: (changeset, applied, total) =>
        console.log(`Applied ${applied}/${total}: index ${changeset.index} ${changeset.id}`),
    });

    return { imodelPath: args.imodelPath, ...result };
  } finally {
    db.close();
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

export const applyChangesetCommand: CommandModule<unknown, ApplyChangesetArgs> = {
  command: "apply",
  describe: "Apply cached changesets to a local iModel, up to a changeset",
  builder: (y) =>
    y
      .option("imodel-path", { type: "string", demandOption: true, describe: "Path to the local iModel file" })
      .option("changeset-id", { type: "string", describe: "Apply up to and including this changeset" })
      .option("changeset-index", { type: "number", describe: "Apply up to and including this changeset index" })
      .option("imodel-id", { type: "string", describe: "The iModel the changesets belong to. Read from the file when omitted" }) as never,
  handler: async (argv) => {
    const result = await runApplyChangesets({
      imodelPath: argv.imodelPath,
      changesetId: argv.changesetId,
      changesetIndex: argv.changesetIndex,
      imodelId: argv.imodelId,
    });
    if (result.applied === 0)
      console.log(`Already at changeset index ${result.toIndex}; nothing to apply.`);
    else
      console.log(`Applied ${result.applied} changeset(s): index ${result.fromIndex} -> ${result.toIndex}.`);
  },
};

/** Exported for the local checkpoint command, which reports the same starting point. */
export { currentChangesetIndex };
