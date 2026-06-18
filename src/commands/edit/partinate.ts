import type { CommandModule } from "yargs";
import { getCacheDb } from "../../cache/cache-db";
import { DEFAULT_BLOB_SIZE, runPartinate, type PartinateResult } from "../util/partinate";

export interface EditPartinateArgs {
  imodelId: string;
  briefcaseId: number;
  blobSize: number;
}

/**
 * Run partinate against a locally downloaded briefcase (resolved by `imodel-id` and
 * `briefcase-id`), leaving the moved geometry as local changes. `runPartinate` calls
 * `saveChanges`, so the result is a pending changeset that `imod hub briefcase push`
 * can push to the hub.
 */
export async function runEditPartinate(args: EditPartinateArgs): Promise<PartinateResult> {
  const row = getCacheDb()
    .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
    .get(args.imodelId, args.briefcaseId) as { file_path: string } | undefined;
  if (!row)
    throw new Error(`Briefcase ${args.briefcaseId} for iModel ${args.imodelId} is not downloaded locally.`);

  return runPartinate({ imodelPath: row.file_path, blobSize: args.blobSize });
}

export const editPartinateCommand: CommandModule<unknown, EditPartinateArgs> = {
  command: "partinate",
  describe:
    "Move large GeometricElement3d GeometryStreams into GeometryParts in a briefcase, creating a changeset that can be pushed",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", demandOption: true, describe: "The downloaded briefcase id to edit" })
      .option("blob-size", {
        type: "number",
        default: DEFAULT_BLOB_SIZE,
        describe: "Only convert elements whose GeometryStream blob exceeds this many bytes",
      }) as never,
  handler: async (argv) => {
    const result = await runEditPartinate({
      imodelId: argv.imodelId,
      briefcaseId: argv.briefcaseId,
      blobSize: argv.blobSize,
    });
    console.log(
      `Moved geometry streams for ${result.converted} element(s); created ${result.partsCreated} GeometryPart(s); skipped ${result.skipped}`,
    );
    console.log(
      `Local changes saved. Push them with: imod hub briefcase push --imodel-id ${argv.imodelId} --briefcase-id ${argv.briefcaseId}`,
    );
  },
};
