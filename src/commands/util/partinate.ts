import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BriefcaseDb, GeometryPart } from "@itwin/core-backend";
import { DbResult, type Id64String } from "@itwin/core-bentley";
import {
  Code,
  GeometryStreamBuilder,
  IModel,
  QueryBinder,
  type GeometricElement3dProps,
  type GeometryPartProps,
  type GeometryStreamProps,
} from "@itwin/core-common";
import { startIModelHost } from "../../host/imodel-host";
import { getAccessToken } from "../../auth/auth-client";

export const DEFAULT_BLOB_SIZE = 1024; // 1 KiB

export interface PartinateArgs {
  imodelPath: string;
  blobSize: number;
}

export interface PartinateResult {
  converted: number;
  partsCreated: number;
  skipped: number;
}

export async function runPartinate(args: PartinateArgs): Promise<PartinateResult> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);
  if (!Number.isFinite(args.blobSize) || args.blobSize <= 0)
    throw new Error(`--blob-size must be a positive number of bytes, got: ${args.blobSize}`);

  await startIModelHost();
  const db = await BriefcaseDb.open({ fileName: args.imodelPath, readonly: false });

  const result: PartinateResult = { converted: 0, partsCreated: 0, skipped: 0 };
  try {
    const candidateIds = await findLargeElements(db, args.blobSize);

    // Lock the entire iModel before editing
    if (candidateIds.length > 0) {
      await db.acquireSchemaLock();
    }

    console.log(`Found ${candidateIds.length} element(s) with GeometryStream blob larger than ${args.blobSize} bytes.`);

    if (candidateIds.length > 0) {
      createTempPartMap(db);
      // Pass 1: create part and save element -> part id mapping in a temp table.
      for (const elementId of candidateIds) {
        const props = db.elements.getElementProps<GeometricElement3dProps>({
          id: elementId,
          wantGeometry: true,
          wantBRepData: true,
        });

        // Skip geometry streams that already contain a part reference
        if (!props.geom || containsPartReference(props.geom)) {
          result.skipped++;
          continue;
        }

        const partProps: GeometryPartProps = {
          classFullName: GeometryPart.classFullName,
          model: IModel.dictionaryId,
          code: Code.createEmpty(),
          geom: props.geom,
        };
        const partId = db.elements.insertElement(partProps);
        recordPartMapping(db, elementId, partId);
        result.partsCreated++;
        if (result.partsCreated % 7000 === 0) {
          console.log(`Created ${result.partsCreated} part(s)...`);
          db.saveChanges(`partinate: created ${result.partsCreated} parts`);
        }
      }
    }

    if (result.partsCreated > 0) {
      db.saveChanges("partinate: parts created");

      // Pass 2: replace each converted element's GeometryStream with a reference to its part.
      for (const { elementId, partId } of readPartMappings(db)) {
        const props = db.elements.getElementProps<GeometricElement3dProps>(elementId);
        const builder = new GeometryStreamBuilder();
        builder.appendGeometryPart3d(partId);
        props.geom = builder.geometryStream;
        db.elements.updateElement(props);
        result.converted++;
        if (result.converted % 7000 === 0) {
          console.log(`Converted ${result.converted} element(s)...`);
          db.saveChanges(`partinate: converted ${result.converted} elements`);
        }
      }

      console.log(`Converted ${result.converted} element(s) into ${result.partsCreated} part(s); skipped ${result.skipped} element(s). Saving changes...`);
      db.saveChanges("partinate complete");
      db.vacuum();
    } else {
      console.log(`No elements needed partination, skipped ${result.skipped} element(s).`);
    }

  } finally {
    db.close();
  }
  return result;
}

function createTempPartMap(db: BriefcaseDb): void {
  db.withSqliteStatement(
    "CREATE TEMP TABLE partinate_map (element_id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL)",
    (stmt) => stmt.step(),
  );
}

function recordPartMapping(db: BriefcaseDb, elementId: Id64String, partId: Id64String): void {
  db.withPreparedSqliteStatement(
    "INSERT INTO partinate_map (element_id, part_id) VALUES (?, ?)",
    (stmt) => {
      stmt.bindId(1, elementId);
      stmt.bindId(2, partId);
      stmt.step();
    },
  );
}

function readPartMappings(db: BriefcaseDb): { elementId: Id64String; partId: Id64String }[] {
  return db.withSqliteStatement(
    "SELECT element_id, part_id FROM partinate_map",
    (stmt) => {
      const mappings: { elementId: Id64String; partId: Id64String }[] = [];
      while (stmt.step() === DbResult.BE_SQLITE_ROW)
        mappings.push({ elementId: stmt.getValueId(0), partId: stmt.getValueId(1) });
      return mappings;
    },
  );
}

/** Ids of GeometricElement3d elements whose GeometryStream exceeds blobSize bytes. */
async function findLargeElements(db: BriefcaseDb, blobSize: number): Promise<string[]> {
  const reader = db.createQueryReader(
    `SELECT ECInstanceId FROM bis.GeometricElement3d
       WHERE GeometryStream IS NOT NULL AND length(GeometryStream) > ?`,
    new QueryBinder().bindInt(1, blobSize),
  );
  const ids: string[] = [];
  for await (const row of reader)
    ids.push(row[0]);
  return ids;
}

function containsPartReference(geom: GeometryStreamProps): boolean {
  return geom.some((entry) => entry.geomPart !== undefined);
}

export const partinateCommand: CommandModule<unknown, PartinateArgs> = {
  command: "partinate",
  describe:
    "Move large GeometricElement3d GeometryStreams into GeometryParts referenced by the element",
  builder: (y) =>
    y
      .option("imodel-path", {
        type: "string",
        demandOption: true,
        describe: "Path to the local iModel file",
      })
      .option("blob-size", {
        type: "number",
        default: DEFAULT_BLOB_SIZE,
        describe: "Only convert elements whose GeometryStream blob exceeds this many bytes",
      }) as never,
  handler: async (argv) => {
    const result = await runPartinate({
      imodelPath: argv.imodelPath,
      blobSize: argv.blobSize,
    });
    console.log(
      `Moved geometry streams for ${result.converted} element(s); created ${result.partsCreated} GeometryPart(s); skipped ${result.skipped}`,
    );
  },
};
