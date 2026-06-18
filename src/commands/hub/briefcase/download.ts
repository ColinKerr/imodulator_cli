import type { CommandModule } from "yargs";
import { BriefcaseManager } from "@itwin/core-backend";
import { startIModelHost } from "../../../host/imodel-host";
import { getAccessToken } from "../../../auth/auth-client";
import { getCacheDb } from "../../../cache/cache-db";

export interface DownloadBriefcaseArgs {
  imodelId: string;
  briefcaseId: number;
  itwinId: string;
}

export async function runDownloadBriefcase(args: DownloadBriefcaseArgs): Promise<string> {
  await startIModelHost();
  const accessToken = await getAccessToken();
  const props = await BriefcaseManager.downloadBriefcase({
    accessToken,
    iTwinId: args.itwinId,
    iModelId: args.imodelId,
    briefcaseId: args.briefcaseId,
  });
  getCacheDb()
    .prepare(
      "INSERT OR REPLACE INTO downloaded_briefcases (imodel_id, briefcase_id, file_path, changeset_id) VALUES (?, ?, ?, ?)",
    )
    .run(args.imodelId, args.briefcaseId, props.fileName, props.changeset.id);
  return props.fileName;
}

export const downloadBriefcaseCommand: CommandModule<unknown, DownloadBriefcaseArgs> = {
  command: "download",
  describe: "Download a briefcase to the local cache",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", demandOption: true, describe: "The briefcase id to download" })
      .option("itwin-id", { type: "string", demandOption: true, describe: "The iTwin id (GUID) that owns the iModel" }) as never,
  handler: async (argv) => {
    const fileName = await runDownloadBriefcase({
      imodelId: argv.imodelId,
      briefcaseId: argv.briefcaseId,
      itwinId: argv.itwinId,
    });
    console.log(`Downloaded briefcase to ${fileName}`);
  },
};
