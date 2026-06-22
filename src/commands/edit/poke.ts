import type { CommandModule } from "yargs";
import { BriefcaseDb } from "@itwin/core-backend";
import { IModel } from "@itwin/core-common";
import { startIModelHost } from "../../host/imodel-host";
import { getCacheDb } from "../../cache/cache-db";
import { getAccessToken } from "../../auth/auth-client";

export interface EditPokeArgs {
  imodelId: string;
  briefcaseId: number;
}

/**
 * Update the LastMod date of the root (repository) model in a locally downloaded
 * briefcase (resolved by `imodel-id` and `briefcase-id`). `updateModel` with
 * `updateLastMod` followed by `saveChanges` leaves a pending changeset that
 * `imod hub briefcase push` can push to the hub. Returns the new LastMod time.
 */
export async function runEditPoke(args: EditPokeArgs): Promise<string> {
  const row = getCacheDb()
    .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
    .get(args.imodelId, args.briefcaseId) as { file_path: string } | undefined;
  if (!row)
    throw new Error(`Briefcase ${args.briefcaseId} for iModel ${args.imodelId} is not downloaded locally.`);

  await startIModelHost();
  await getAccessToken(); // ensure auth client is signed in and has a valid access token
  const db = await BriefcaseDb.open({ fileName: row.file_path, readonly: false });
  try {
    await db.locks.acquireLocks({ exclusive: [IModel.repositoryModelId] });
    const props = db.models.getModelProps(IModel.repositoryModelId);
    db.models.updateModel({ ...props, updateLastMod: true });
    db.saveChanges("poke: updated root model last mod");
    return db.models.queryLastModifiedTime(IModel.repositoryModelId);
  } finally {
    db.close();
  }
}

export const editPokeCommand: CommandModule<unknown, EditPokeArgs> = {
  command: "poke",
  describe:
    "Update the last mod date of the root model in a briefcase, creating a changeset that can be pushed",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", demandOption: true, describe: "The downloaded briefcase id to edit" }) as never,
  handler: async (argv) => {
    const lastMod = await runEditPoke({
      imodelId: argv.imodelId,
      briefcaseId: argv.briefcaseId,
    });
    console.log(`Updated root model last mod to ${lastMod}`);
    console.log(
      `Local changes saved. Push them with: imod hub briefcase push --imodel-id ${argv.imodelId} --briefcase-id ${argv.briefcaseId}`,
    );
  },
};
