import type { CommandModule } from "yargs";
import { BriefcaseDb } from "@itwin/core-backend";
import { getCacheDb } from "../../cache/cache-db";
import { runUpdateProfile, type UpdateProfileResult } from "../util/update-profile";
import { getAccessToken } from "../../auth/auth-client";

export interface EditUpdateProfileArgs {
  imodelId: string;
  briefcaseId: number;
  dryRun?: boolean;
}

/**
 * Update the profile of a locally downloaded briefcase (resolved by `imodel-id` and
 * `briefcase-id`), leaving the result as local changes that `imod hub briefcase push` can
 * push to the hub.
 *
 * The schema lock ensures no other briefcases can make changes.
 */
export async function runEditUpdateProfile(args: EditUpdateProfileArgs): Promise<UpdateProfileResult> {
  const row = getCacheDb()
    .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
    .get(args.imodelId, args.briefcaseId) as { file_path: string } | undefined;
  if (!row)
    throw new Error(`Briefcase ${args.briefcaseId} for iModel ${args.imodelId} is not downloaded locally.`);

  await getAccessToken(); // ensure auth client is signed in and has a valid access token

  // Nothing to lock for a dry run, which only reads.
  if (!args.dryRun)
    await acquireSchemaLock(row.file_path);

  // The upgrade happens on open, so the briefcase must be closed again before it runs.
  return runUpdateProfile({ imodelPath: row.file_path, dryRun: args.dryRun });
}

async function acquireSchemaLock(fileName: string): Promise<void> {
  const db = await BriefcaseDb.open({ fileName, readonly: false });
  try {
    await db.acquireSchemaLock();
  } finally {
    db.close();
  }
}

export const editUpdateProfileCommand: CommandModule<unknown, EditUpdateProfileArgs> = {
  command: "update-profile",
  describe:
    "Update a downloaded briefcase's profile to the latest supported by iTwin.js, creating a changeset that can be pushed",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", demandOption: true, describe: "The downloaded briefcase id to update" })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Report the current profile versions and schema state, without writing",
      }) as never,
  handler: async (argv) => {
    const result = await runEditUpdateProfile({
      imodelId: argv.imodelId,
      briefcaseId: argv.briefcaseId,
      dryRun: argv.dryRun,
    });
    if (result.changed)
      console.log(
        `Local changes saved. Push them with: imod hub briefcase push --imodel-id ${argv.imodelId} --briefcase-id ${argv.briefcaseId}`,
      );
  },
};
