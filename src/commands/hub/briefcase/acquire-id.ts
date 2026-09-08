import type { CommandModule } from "yargs";
import { startIModelHost } from "../../../host/imodel-host";
import { getActiveHubAccess } from "../../../host/hub-access";
import { getCacheDb } from "../../../cache/cache-db";
import { recordIModelDetails } from "../../../cache/imodels";

export interface acquireIdArgs {
  imodelId: string;
}

export async function runacquireId(args: acquireIdArgs): Promise<number> {
  await startIModelHost();
  const briefcaseId = await getActiveHubAccess().acquireNewBriefcaseId({
    iModelId: args.imodelId,
  });
  getCacheDb()
    .prepare("INSERT OR REPLACE INTO briefcase_ids (imodel_id, briefcase_id) VALUES (?, ?)")
    .run(args.imodelId, briefcaseId);
  await recordIModelDetails(args.imodelId);
  return briefcaseId;
}

export const acquireIdCommand: CommandModule<unknown, acquireIdArgs> = {
  command: "acquire-id",
  describe: "Acquire a new briefcase id for the iModel",
  builder: (y) =>
    y.option("imodel-id", {
      type: "string",
      demandOption: true,
      describe: "The iModel id (GUID)",
    }) as never,
  handler: async (argv) => {
    const briefcaseId = await runacquireId({ imodelId: argv.imodelId });
    console.log(`Acquired briefcase id ${briefcaseId} for iModel ${argv.imodelId}`);
  },
};
