import type { CommandModule } from "yargs";
import { BriefcaseDb } from "@itwin/core-backend";
import { startIModelHost } from "../../host/imodel-host";
import { getCacheDb } from "../../cache/cache-db";
import { loadMappingFile } from "../../transform/mapping-file";
import { countBySourceClass, resolvePropertyMap, runMapTransform, type ResolvedClassMapping } from "../../transform/map-transformer";

export interface UsingMapArgs {
  imodelId: string;
  briefcaseId: number;
  mapFile: string;
  dryRun: boolean;
}

export interface UsingMapDryRunResult {
  dryRun: true;
  classMappings: { sourceClass: string; targetClass: string; count: number }[];
  total: number;
}

export interface UsingMapTransformResult {
  dryRun: false;
  converted: number;
  perClass: Record<string, number>;
  navReferencesRepointed: number;
  linkRelationshipsRepointed: number;
  aspectsConverted: number;
  relationshipsConverted: number;
}

export type UsingMapResult = UsingMapDryRunResult | UsingMapTransformResult;

/**
 * Convert elements of the source classes named in the mapping file to their target classes
 * within a downloaded briefcase, leaving a pushable changeset. With `dryRun`, report the
 * counts that would be converted (grouped by source class) without modifying the briefcase.
 * Either way the mapping is validated against the iModel's schemas first, so an ambiguous
 * mapping fails before any change is made. See ../../transform/element-mapping.schema.json
 * for the mapping file format.
 */
export async function runUsingMap(args: UsingMapArgs): Promise<UsingMapResult> {
  const mapping = loadMappingFile(args.mapFile);

  const row = getCacheDb()
    .prepare("SELECT file_path FROM downloaded_briefcases WHERE imodel_id = ? AND briefcase_id = ?")
    .get(args.imodelId, args.briefcaseId) as { file_path: string } | undefined;
  if (!row)
    throw new Error(`Briefcase ${args.briefcaseId} for iModel ${args.imodelId} is not downloaded locally.`);

  await startIModelHost();

  if (args.dryRun) {
    const db = await BriefcaseDb.open({ fileName: row.file_path, readonly: true });
    try {
      const resolved = await resolveAll(db, mapping.ElementMapping.ClassMappings);
      const counts = await countBySourceClass(db, resolved);
      const classMappings = resolved.map((r) => ({
        sourceClass: r.sourceClassFullName,
        targetClass: r.targetClassFullName,
        count: counts[r.sourceClassFullName] ?? 0,
      }));
      return { dryRun: true, classMappings, total: classMappings.reduce((sum, c) => sum + c.count, 0) };
    } finally {
      db.close();
    }
  }

  const db = await BriefcaseDb.open({ fileName: row.file_path, readonly: false });
  try {
    await db.acquireSchemaLock();
    const resolved = await resolveAll(db, mapping.ElementMapping.ClassMappings);
    const result = await runMapTransform(db, resolved);
    return {
      dryRun: false,
      converted: result.converted,
      perClass: result.perClass,
      navReferencesRepointed: result.navReferencesRepointed,
      linkRelationshipsRepointed: result.linkRelationshipsRepointed,
      aspectsConverted: result.aspectsConverted,
      relationshipsConverted: result.relationshipsConverted,
    };
  } finally {
    db.close();
  }
}

async function resolveAll(db: BriefcaseDb, classMappings: ReturnType<typeof loadMappingFile>["ElementMapping"]["ClassMappings"]): Promise<ResolvedClassMapping[]> {
  const resolved: ResolvedClassMapping[] = [];
  for (const cm of classMappings)
    resolved.push(await resolvePropertyMap(db, cm));
  return resolved;
}

export const usingMapCommand: CommandModule<unknown, UsingMapArgs> = {
  command: "using-map",
  describe:
    "Convert elements to target classes in a briefcase using a JSON mapping file, creating a changeset that can be pushed",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("briefcase-id", { type: "number", demandOption: true, describe: "The downloaded briefcase id to transform" })
      .option("map-file", { type: "string", demandOption: true, describe: "Path to the JSON element mapping file" })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Report the element counts that would be converted, grouped by source class, without making changes",
      }) as never,
  handler: async (argv) => {
    const result = await runUsingMap({
      imodelId: argv.imodelId,
      briefcaseId: argv.briefcaseId,
      mapFile: argv.mapFile,
      dryRun: argv.dryRun,
    });
    if (result.dryRun) {
      console.log(JSON.stringify({ classMappings: result.classMappings, total: result.total }, null, 2));
      return;
    }
    console.log(`Converted instances to their target classes:`);
    for (const [sourceClass, n] of Object.entries(result.perClass))
      console.log(`  ${sourceClass}: ${n}`);
    if (result.aspectsConverted > 0 || result.relationshipsConverted > 0)
      console.log(
        `Re-classed ${result.aspectsConverted} aspect(s) and ${result.relationshipsConverted} relationship(s).`,
      );
    if (result.navReferencesRepointed > 0 || result.linkRelationshipsRepointed > 0)
      console.log(
        `Re-pointed ${result.navReferencesRepointed} navigation reference(s) and ${result.linkRelationshipsRepointed} relationship(s).`,
      );
    console.log(
      `Local changes saved. Push them with: imod hub briefcase push --imodel-id ${argv.imodelId} --briefcase-id ${argv.briefcaseId}`,
    );
  },
};
