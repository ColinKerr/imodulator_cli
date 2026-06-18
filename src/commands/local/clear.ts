import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { getCacheDb } from "../../cache/cache-db";
import { getIModelCacheDir } from "../../cache/cache-dir";

export interface ClearLocalArgs {
  imodelId: string;
  briefcaseId?: number;
  changesetId?: string;
}

export async function runClearLocal(args: ClearLocalArgs): Promise<number> {
  const db = getCacheDb();
  let removed = 0;

  if (args.briefcaseId !== undefined) {
    const row = db
      .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
      .get(args.imodelId, args.briefcaseId) as { file_path: string } | undefined;
    if (row) {
      fs.rmSync(row.file_path, { force: true });
      db.prepare("DELETE FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
        .run(args.imodelId, args.briefcaseId);
      removed = 1;
    }
    return removed;
  }

  if (args.changesetId !== undefined) {
    const row = db
      .prepare("SELECT file_path FROM downloaded_checkpoints WHERE imodel_id = ? AND changeset_id = ?")
      .get(args.imodelId, args.changesetId) as { file_path: string } | undefined;
    if (row) {
      fs.rmSync(row.file_path, { force: true });
      db.prepare("DELETE FROM downloaded_checkpoints WHERE imodel_id = ? AND changeset_id = ?")
        .run(args.imodelId, args.changesetId);
      removed = 1;
    }
    return removed;
  }

  const dir = getIModelCacheDir(args.imodelId);
  if (fs.existsSync(dir))
    fs.rmSync(dir, { recursive: true, force: true });
  const briefcaseDelete = db
    .prepare("DELETE FROM downloaded_briefcases WHERE imodel_id = ?")
    .run(args.imodelId).changes;
  const checkpointDelete = db
    .prepare("DELETE FROM downloaded_checkpoints WHERE imodel_id = ?")
    .run(args.imodelId).changes;
  return briefcaseDelete + checkpointDelete;
}

export const clearLocalCommand: CommandModule<unknown, ClearLocalArgs> = {
  command: "clear",
  describe: "Clear locally cached iModel files",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", describe: "Limit clear to a specific briefcase" })
      .option("changeset-id", { type: "string", describe: "Limit clear to a specific checkpoint" }) as never,
  handler: async (argv) => {
    const count = await runClearLocal({
      imodelId: argv.imodelId,
      briefcaseId: argv.briefcaseId,
      changesetId: argv.changesetId,
    });
    console.log(`Cleared ${count} cached entries for iModel ${argv.imodelId}`);
  },
};
