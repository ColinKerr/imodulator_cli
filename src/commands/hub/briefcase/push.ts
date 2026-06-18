import type { CommandModule } from "yargs";
import { BriefcaseDb } from "@itwin/core-backend";
import { startIModelHost } from "../../../host/imodel-host";
import { getAccessToken } from "../../../auth/auth-client";
import { getCacheDb } from "../../../cache/cache-db";

export interface PushBriefcaseArgs {
  imodelId: string;
  briefcaseId: number;
  description?: string;
}

export async function runPushBriefcase(args: PushBriefcaseArgs): Promise<string | undefined> {
  await startIModelHost();
  const accessToken = await getAccessToken();

  const row = getCacheDb()
    .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
    .get(args.imodelId, args.briefcaseId) as { file_path: string } | undefined;
  if (!row)
    throw new Error(`Briefcase ${args.briefcaseId} for iModel ${args.imodelId} is not downloaded locally.`);

  const db = await BriefcaseDb.open({ fileName: row.file_path });
  try {
    await db.pushChanges({
      accessToken,
      description: args.description ?? "imod push",
    });
    return db.changeset.id;
  } finally {
    db.close();
  }
}

export const pushBriefcaseCommand: CommandModule<unknown, PushBriefcaseArgs> = {
  command: "push",
  describe: "Push local briefcase changes to the hub",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", demandOption: true, describe: "The briefcase id to push" })
      .option("description", { type: "string", describe: "Description of the changeset to push" }) as never,
  handler: async (argv) => {
    const changesetId = await runPushBriefcase({
      imodelId: argv.imodelId,
      briefcaseId: argv.briefcaseId,
      description: argv.description,
    });
    console.log(`Pushed changes; new changeset id: ${changesetId ?? "(none)"}`);
  },
};
