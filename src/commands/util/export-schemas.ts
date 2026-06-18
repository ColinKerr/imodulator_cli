import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BriefcaseDb } from "@itwin/core-backend";
import { startIModelHost } from "../../host/imodel-host";
import { getCacheDb } from "../../cache/cache-db";

export interface ExportSchemasArgs {
  imodelId: string;
  briefcaseId?: number;
  changesetId?: string;
  schemaPath: string;
}

export async function runExportSchemas(args: ExportSchemasArgs): Promise<string> {
  if ((args.briefcaseId === undefined) === (args.changesetId === undefined))
    throw new Error("Provide exactly one of --briefcase-id or --changeset-id");

  await startIModelHost();
  const filePath = resolveLocalIModelFile(args);
  fs.mkdirSync(args.schemaPath, { recursive: true });

  const db = await BriefcaseDb.open({ fileName: filePath, readonly: true });
  try {
    db.exportSchemas(args.schemaPath);
  } finally {
    db.close();
  }
  return args.schemaPath;
}

function resolveLocalIModelFile(args: ExportSchemasArgs): string {
  const cache = getCacheDb();
  if (args.briefcaseId !== undefined) {
    const row = cache
      .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
      .get(args.imodelId, args.briefcaseId) as { file_path: string } | undefined;
    if (!row)
      throw new Error(`Briefcase ${args.briefcaseId} for iModel ${args.imodelId} is not downloaded locally.`);
    return row.file_path;
  }
  const row = cache
    .prepare("SELECT file_path FROM downloaded_checkpoints WHERE imodel_id = ? AND changeset_id = ?")
    .get(args.imodelId, args.changesetId!) as { file_path: string } | undefined;
  if (!row)
    throw new Error(`Checkpoint at changeset ${args.changesetId} for iModel ${args.imodelId} is not downloaded locally.`);
  return row.file_path;
}

export const exportSchemasCommand: CommandModule<unknown, ExportSchemasArgs> = {
  command: "export-schemas",
  describe: "Export schemas from a locally cached iModel to a directory",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", describe: "The briefcase id of the cached briefcase" })
      .option("changeset-id", { type: "string", describe: "The changeset id of the cached checkpoint" })
      .option("schema-path", { type: "string", demandOption: true, describe: "Output directory for schema files" }) as never,
  handler: async (argv) => {
    const dir = await runExportSchemas({
      imodelId: argv.imodelId,
      briefcaseId: argv.briefcaseId,
      changesetId: argv.changesetId,
      schemaPath: argv.schemaPath,
    });
    console.log(`Exported schemas to ${dir}`);
  },
};
