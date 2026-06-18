import type { CommandModule } from "yargs";
import { startIModelHost } from "../../../host/imodel-host";
import { getHubAccess } from "../../../host/hub-access";
import { getAccessToken } from "../../../auth/auth-client";
import { getCacheDb } from "../../../cache/cache-db";

export interface ReleaseIdArgs {
  imodelId: string;
  briefcaseId: number;
}

export async function runReleaseId(args: ReleaseIdArgs): Promise<void> {
  await startIModelHost();
  const accessToken = await getAccessToken();
  await getHubAccess().releaseBriefcase({
    accessToken,
    iModelId: args.imodelId,
    briefcaseId: args.briefcaseId,
  });
  getCacheDb()
    .prepare("DELETE FROM briefcase_ids WHERE imodel_id = ? AND briefcase_id = ?")
    .run(args.imodelId, args.briefcaseId);
}

export const releaseIdCommand: CommandModule<unknown, ReleaseIdArgs> = {
  command: "release-id",
  describe: "Release a briefcase id back to the hub",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", demandOption: true, describe: "The briefcase id to release" }) as never,
  handler: async (argv) => {
    await runReleaseId({ imodelId: argv.imodelId, briefcaseId: argv.briefcaseId });
    console.log(`Released briefcase id ${argv.briefcaseId} for iModel ${argv.imodelId}`);
  },
};
