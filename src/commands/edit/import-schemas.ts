import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import * as path from "node:path";
import { BriefcaseDb } from "@itwin/core-backend";
import { startIModelHost } from "../../host/imodel-host";
import { getCacheDb } from "../../cache/cache-db";
import { getAccessToken } from "../../auth/auth-client";

export interface ImportSchemasArgs {
  imodelId: string;
  briefcaseId: number;
  schemaPath: string;
}

/**
 * Import the schema file(s) at `schemaPath` into a locally downloaded briefcase
 * (resolved by `imodel-id` and `briefcase-id`). `IModelDb.importSchemas` obtains the
 * schema lock and saves changes on success, so the result is a pending changeset that
 * `imod hub briefcase push` can push to the hub. Returns the imported file paths.
 */
export async function runImportSchemas(args: ImportSchemasArgs): Promise<string[]> {
  const schemaFiles = resolveSchemaFiles(args.schemaPath);
  if (schemaFiles.length === 0)
    throw new Error(`No schema files (*.ecschema.xml) found at ${args.schemaPath}`);

  const row = getCacheDb()
    .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
    .get(args.imodelId, args.briefcaseId) as { file_path: string } | undefined;
  if (!row)
    throw new Error(`Briefcase ${args.briefcaseId} for iModel ${args.imodelId} is not downloaded locally.`);

  await startIModelHost();
  await getAccessToken(); // ensure auth client is signed in and has a valid access token
  const db = await BriefcaseDb.open({ fileName: row.file_path, readonly: false });
  try {
    await db.acquireSchemaLock();
    await db.importSchemas(schemaFiles);
  } finally {
    db.close();
  }
  return schemaFiles;
}

/** A single schema file, or every `*.ecschema.xml` file in a directory. */
function resolveSchemaFiles(schemaPath: string): string[] {
  if (!fs.existsSync(schemaPath))
    throw new Error(`Schema path not found: ${schemaPath}`);
  if (fs.statSync(schemaPath).isFile())
    return [schemaPath];
  return fs
    .readdirSync(schemaPath)
    .filter((name) => name.toLowerCase().endsWith(".ecschema.xml"))
    .sort()
    .map((name) => path.join(schemaPath, name));
}

export const importSchemasCommand: CommandModule<unknown, ImportSchemasArgs> = {
  command: "import-schemas",
  describe:
    "Import schemas into a briefcase, creating a changeset that can be pushed",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", demandOption: true, describe: "The downloaded briefcase id to import into" })
      .option("schema-path", {
        type: "string",
        demandOption: true,
        describe: "A schema file, or a directory of .ecschema.xml files, to import",
      }) as never,
  handler: async (argv) => {
    const files = await runImportSchemas({
      imodelId: argv.imodelId,
      briefcaseId: argv.briefcaseId,
      schemaPath: argv.schemaPath,
    });
    console.log(`Imported ${files.length} schema(s) into briefcase ${argv.briefcaseId}`);
    console.log(
      `Local changes saved. Push them with: imod hub briefcase push --imodel-id ${argv.imodelId} --briefcase-id ${argv.briefcaseId}`,
    );
  },
};
