import type { CommandModule } from "yargs";
import { startIModelHost } from "../../../host/imodel-host";
import { getHubAccess } from "../../../host/hub-access";
import { getAccessToken } from "../../../auth/auth-client";
import { getCacheDb } from "../../../cache/cache-db";

export interface acquireIdArgs {
  imodelId: string;
}

export async function runacquireId(args: acquireIdArgs): Promise<number> {
  await startIModelHost();
  const accessToken = await getAccessToken();
  const briefcaseId = await getHubAccess().acquireNewBriefcaseId({
    accessToken,
    iModelId: args.imodelId,
  });
  getCacheDb()
    .prepare("INSERT OR REPLACE INTO briefcase_ids (imodel_id, briefcase_id) VALUES (?, ?)")
    .run(args.imodelId, briefcaseId);
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
