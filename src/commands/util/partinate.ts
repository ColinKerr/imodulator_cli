import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BriefcaseDb, GeometryPart, IModelDb } from "@itwin/core-backend";
import {
  AuthorizationClient,
  Code,
  ElementGeometry,
  ElementGeometryOpcode,
  GeometryParams,
  IModel,
  QueryBinder,
  type ElementGeometryDataEntry,
  type ElementGeometryInfo,
  type GeometricElement3dProps,
  type GeometryPartProps,
} from "@itwin/core-common";
import { startIModelHost } from "../../host/imodel-host";
import { noopAuthClient } from "../../auth/noop-auth-client";
import { Id64, IModelStatus, type Id64String } from "@itwin/core-bentley";

export const DEFAULT_BLOB_SIZE = 4 * 1024; // 4 KiB

export interface PartinateArgs {
  imodelPath: string;
  blobSize: number;
}

/**
 * Reason an element's GeometryStream was not moved into a GeometryPart.
 */
export type SkipReason =
  | "failedToGetElementGeometry"
  | "geometryIncompatibleWithPart"
  | "partReference"
  | "subCategoryChange"
  | "appearanceReset"
  | "streamFlags"
  | "noGeometry";

export const SKIP_REASONS: readonly SkipReason[] = [
  "failedToGetElementGeometry",
  "geometryIncompatibleWithPart",
  "partReference",
  "subCategoryChange",
  "appearanceReset",
  "streamFlags",
  "noGeometry",
];

export interface PartinateResult {
  converted: number;
  partsCreated: number;
  skipped: number;
  skippedByReason: Record<SkipReason, number>;
}

export async function runPartinate(args: PartinateArgs, authClient: AuthorizationClient | undefined = undefined): Promise<PartinateResult> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);
  if (!Number.isFinite(args.blobSize) || args.blobSize <= 0)
    throw new Error(`--blob-size must be a positive number of bytes, got: ${args.blobSize}`);

  await startIModelHost(authClient);
  const db = await BriefcaseDb.open({ fileName: args.imodelPath, readonly: false });

  const result: PartinateResult = {
    converted: 0,
    partsCreated: 0,
    skipped: 0,
    skippedByReason: Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<SkipReason, number>,
  };

  const skip = (reason: SkipReason) => {
    result.skipped++;
    result.skippedByReason[reason]++;
  };

  try {
    const candidateIds = await findLargeElements(db, args.blobSize);

    // Lock the entire iModel before editing
    if (candidateIds.length > 0) {
      await db.acquireSchemaLock();
    }

    console.log(`Found ${candidateIds.length} element(s) with GeometryStream blob larger than ${args.blobSize} bytes.`);

    let convertedBytes = 0
    for (const elementId of candidateIds) {
      const info = requestGeometry(db, elementId);
      if (!info) {
        skip("failedToGetElementGeometry");
        console.warn(`Leaving element ${elementId} unconverted: could not read its geometry stream.`);
        continue;
      }

      // Skip elements if their geometry stream cannot be stored in a geometry part.
      const prepared = prepareForPart(info);
      if ("skip" in prepared) {
        skip(prepared.skip);
        continue;
      }
      const { entryArray } = prepared;

      const partProps: GeometryPartProps = {
        classFullName: GeometryPart.classFullName,
        model: IModel.dictionaryId,
        code: Code.createEmpty(),
        elementGeometryBuilderParams: { entryArray, is2dPart: false },
      };

      // Skip partination for the element if its geometry stream not a valid GeometryPart geometry stream.
      // Necessary because some incompatibilities cannot be detected without parsing the geometry stream.  
      let partId;
      try {
        partId = db.elements.insertElement(partProps);
        result.partsCreated++;
      } catch {
        skip("geometryIncompatibleWithPart");
        continue;
      }

      try {
        const partEntry = ElementGeometry.fromGeometryPart(partId);
        if (!partEntry)
          throw new Error(`could not build a part reference to ${partId}`);

        const props = db.elements.getElementProps<GeometricElement3dProps>(elementId);
        props.geom = undefined;
        props.elementGeometryBuilderParams = { entryArray: [partEntry] };
        db.elements.updateElement(props);
        result.converted++;

        // Force up for breath of air to ensure GC can run.
        await new Promise((resolve) => setImmediate(resolve));

        process.stdout.write(`\rConverted ${result.converted} element(s)...`);

        if (result.converted % 7000 === 0) {
          db.saveChanges(`partinate in progress: converted ${result.converted} elements`);
        }
      } catch (err) {
        console.error(
          `Partination Failed: Part created for element ${elementId} but updating element failed: ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    }

    if (result.converted > 0) {
      console.log(`\nMoved ${result.converted} element(s) GeometryStreams into ${result.partsCreated} part(s); skipped ${result.skipped} element(s)${summarizeSkips(result)}. Saving changes...`);
      db.saveChanges(`Moved ${result.converted} element(s) GeometryStreams into ${result.partsCreated} part(s)`);
    } else {
      console.log(`No elements needed partination, skipped ${result.skipped} element(s)${summarizeSkips(result)}.`);
    }

  } finally {
    db.close();
    // Vacuum in new connection to avoid crash on some iModels when done on the same connection as the edits.
    if(result.converted > 0) {
      console.log("Vacuuming iModel");
      const db2 = await BriefcaseDb.open({ fileName: args.imodelPath, readonly: false });
      db2.close({optimize: true});
    }
  }
  return result;
}


/** Ids of GeometricElement3d elements whose GeometryStream exceeds blobSize bytes. */
async function findLargeElements(db: BriefcaseDb, blobSize: number): Promise<Id64String[]> {
  const reader = db.createQueryReader(
    `SELECT ECInstanceId FROM bis.GeometricElement3d
       WHERE GeometryStream IS NOT NULL AND length(GeometryStream) > ?`,
    new QueryBinder().bindInt(1, blobSize),
  );
  const ids: Id64String[] = [];
  for await (const row of reader)
    ids.push(row[0]);
  return ids;
}

function requestGeometry(db: IModelDb, elementId: Id64String): ElementGeometryInfo | undefined {
  let info: ElementGeometryInfo | undefined;
  const status = db.elementGeometryRequest({
    elementId,
    onGeometry: (geometry) => { info = geometry; },
  });
  return status === IModelStatus.Success ? info : undefined;
}

/** The entries to store in the part, or the reason the element must be left alone. */
export type PreparedPart =
  | { skip: SkipReason }
  | { entryArray: ElementGeometryDataEntry[] };

/**
 * Test if the GeometryStream can be moved to a GeometryPart, and if so return
 * the entries to store there.
 *
 * For compatibility details see the
 * ElementGeometry/GeometryStreamBuilder docs in @itwin/core-common and
 * `docs/learning/common/geometrystream.md` in itwinjs-core. Some of these conditions make
 * the part insert fail outright; the rest would silently change how the element draws.
 */
export function prepareForPart(info: ElementGeometryInfo): PreparedPart {
  // View-independence is a property of the stream that holds it. Replacing the element's
  // stream with a bare part reference would drop it.
  if (info.viewIndependent)
    return { skip: "streamFlags" };

  // A part has no Category, so it cannot hold a sub-category reference. Symbology that
  // names a sub-category other than the element's default would be lost on conversion.
  const defaultSubCategoryId = info.categoryId
    ? IModelDb.getDefaultSubCategoryId(info.categoryId)
    : undefined;

  const entryArray: ElementGeometryDataEntry[] = [];
  let geometricEntries = 0;
  let overrideInEffect = false;

  for (const entry of info.entryArray) {
    // Nesting of parts is not supported; the insert is rejected.
    if (entry.opcode === ElementGeometryOpcode.PartReference)
      return { skip: "partReference" };

    // Sub-graphic ranges are ignored inside a part, so there is no point carrying them.
    if (entry.opcode === ElementGeometryOpcode.SubGraphicRange)
      continue;

    if (entry.opcode === ElementGeometryOpcode.BasicSymbology) {
      const symbology = readSymbology(entry);

      if (Id64.isValidId64(symbology.subCategoryId) && symbology.subCategoryId !== defaultSubCategoryId)
        return { skip: "subCategoryChange" };

      // If there is a symbology override in effect setting no symbology drops the override.
      // This is incompatible with a GeometryPart.
      if (!symbology.setsAnything) {
        if (overrideInEffect)
          return { skip: "appearanceReset" };
        continue;
      }
    }

    if (ElementGeometry.isAppearanceEntry(entry))
      overrideInEffect = true;
    else if (ElementGeometry.isGeometricEntry(entry))
      geometricEntries++;

    entryArray.push(entry);
  }

  if (geometricEntries === 0)
    return { skip: "noGeometry" };

  return { entryArray };
}

/** Read the sub-category and whether anything is overridden from a BasicSymbology entry. */
function readSymbology(entry: ElementGeometryDataEntry): {
  subCategoryId: Id64String;
  setsAnything: boolean;
} {
  const params = new GeometryParams(Id64.invalid);
  const setsAnything = ElementGeometry.updateGeometryParams(entry, params);
  return { subCategoryId: params.subCategoryId, setsAnything };
}

function summarizeSkips(result: PartinateResult): string {
  const parts = SKIP_REASONS.filter((reason) => result.skippedByReason[reason] > 0).map(
    (reason) => `${reason}: ${result.skippedByReason[reason]}`,
  );
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
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
    }, noopAuthClient);
  },
};
