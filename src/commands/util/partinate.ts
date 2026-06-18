import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BriefcaseDb, GeometryPart } from "@itwin/core-backend";
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

export const DEFAULT_BLOB_SIZE = 4 * 1024; // 4 KiB

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
      result.partsCreated++;

      const builder = new GeometryStreamBuilder();
      builder.appendGeometryPart3d(partId);
      props.geom = builder.geometryStream;
      db.elements.updateElement(props);
      result.converted++;
    }

    db.saveChanges("partinate");

    db.vacuum();
  } finally {
    db.close();
  }
  return result;
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
