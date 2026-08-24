import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { startIModelHost } from "../../host/imodel-host";
import { noopAuthClient } from "../../auth/noop-auth-client";
import { buildIsPrivateOverrideSchema, importSchemaFile } from "../../remap/biscore-override";
import { mapipulateData, RemapResult } from "../../remap/geometry-part-table";
import { remapOutputPath, remapProfile, REMAP_TYPES, type RemapType } from "../../remap/remap-type";
import { formatChecks, validateRemap, type RemapCheck } from "../../remap/validate";
import { runUpdateProfile } from "./update-profile";
import { formatBytes, formatDuration } from "./vacuum";

export const DEFAULT_TILE_MODELS = 10;

export interface MapipulateArgs {
  imodelPath: string;
  remapType: RemapType;
  validate?: boolean;
  tileModels?: number;
  force?: boolean;
}

export interface MapipulateResult {
  outputPath: string;
  /** GeometryParts whose geometry moved into the new table. */
  parts: number;
  geometryBytes: number;
  bytesBefore: number;
  bytesAfter: number;
  elapsedMs: number;
  checks?: RemapCheck[];
  /** Undefined when validation did not run. */
  valid?: boolean;
}

/**
 * Copy the source, folding any live WAL into the copy. Copying only the main file of a
 * database with a live WAL yields a copy missing committed pages.
 */
function copyToTarget(sourcePath: string, targetPath: string, force: boolean): void {
  if (fs.existsSync(targetPath) && !force)
    throw new Error(`${targetPath} already exists. Pass --force to overwrite it.`);
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(`${targetPath}${suffix}`, { force: true });

  fs.copyFileSync(sourcePath, targetPath);
  let hadWal = false;
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${sourcePath}${suffix}`)) {
      fs.copyFileSync(`${sourcePath}${suffix}`, `${targetPath}${suffix}`);
      hadWal = true;
    }
  }
  if (hadWal) {
    const db = new Database(targetPath);
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }
}

function vacuum(targetPath: string): void {
  const db = new Database(targetPath);
  try {
    db.exec("VACUUM");
  } finally {
    db.close();
  }
}

/**
 * Move GeometryPart geometry into a table of its own, on a copy of the iModel.
 *
 * The profile and domain schemas are upgraded, metadata is updated, data is moved then vacuum is called.
 */
export async function runMapipulate(args: MapipulateArgs): Promise<MapipulateResult> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);

  const profile = remapProfile(args.remapType);
  const outputPath = remapOutputPath(args.imodelPath, args.remapType);
  if (outputPath === args.imodelPath)
    throw new Error("The converted iModel would overwrite the source.");

  await startIModelHost(noopAuthClient);

  const bytesBefore = fs.statSync(args.imodelPath).size;
  const startedAt = Date.now();

  console.log(`Copying to ${outputPath} (${formatBytes(bytesBefore)})...`);
  copyToTarget(args.imodelPath, outputPath, args.force ?? false);

  console.log("Updating the profile and domain schemas...");
  await runUpdateProfile({ imodelPath: outputPath });

  if (profile.overrideIsPrivate) {
    const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "imod-biscore-"));
    try {
      const schema = buildIsPrivateOverrideSchema(outputPath, schemaDir);
      console.log(`Importing BisCore ${schema.version} with IsPrivate declared on GeometryPart...`);
      importSchemaFile(outputPath, schema.filePath);
    } finally {
      fs.rmSync(schemaDir, { recursive: true, force: true });
    }
  }

  console.log(`Applying remap type ${args.remapType}...`);
  const db = new Database(outputPath);
  let remapResult: RemapResult;
  try {
    db.pragma("journal_mode = delete");
    db.pragma("foreign_keys = OFF");
    remapResult = mapipulateData(db, profile);
  } finally {
    db.close();
  }
  console.log(
    `Moved ${remapResult.parts} GeometryPart(s), ${formatBytes(remapResult.geometryBytes)} of geometry, into bis_GeometryPart.`,
  );
  if (remapResult.extendedTypesPatched > 0)
    console.log(`Wrote ${remapResult.extendedTypesPatched} ECDbSystem extended type(s) to disk.`);

  console.log("Vacuuming...");
  vacuum(outputPath);

  const bytesAfter = fs.statSync(outputPath).size;
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `Converted in ${formatDuration(elapsedMs)}: ${formatBytes(bytesBefore)} -> ${formatBytes(bytesAfter)}.`,
  );

  const result: MapipulateResult = {
    outputPath,
    parts: remapResult.parts,
    geometryBytes: remapResult.geometryBytes,
    bytesBefore,
    bytesAfter,
    elapsedMs,
  };

  if (args.validate) {
    const tileModels = args.tileModels ?? DEFAULT_TILE_MODELS;
    console.log(`Validating${tileModels > 0 ? ` (root tiles for up to ${tileModels} model(s))` : ""}...`);
    const checks = await validateRemap({
      sourcePath: args.imodelPath,
      targetPath: outputPath,
      profile,
      tileModels,
    });
    const failed = checks.filter((check) => !check.passed);
    console.log(formatChecks(checks));
    console.log(
      `${checks.length - failed.length}/${checks.length} checks passed${failed.length > 0 ? `, ${failed.length} FAILED` : ""}.`,
    );
    result.checks = checks;
    result.valid = failed.length === 0;
  }

  return result;
}

export const mapipulateCommand: CommandModule<unknown, MapipulateArgs> = {
  command: "mapipulate",
  describe: "Move GeometryPart geometry into a table of its own, in a copy of the iModel",
  builder: (y) =>
    y
      .option("imodel-path", {
        type: "string",
        demandOption: true,
        describe: "Path to the local iModel file. It is opened read-only and never written",
      })
      .option("remap-type", {
        type: "number",
        choices: REMAP_TYPES,
        demandOption: true,
        describe: "Which set of mapping changes to apply",
      })
      .option("validate", {
        type: "boolean",
        default: false,
        describe: "Compare the converted iModel against its source",
      })
      .option("tile-models", {
        type: "number",
        default: DEFAULT_TILE_MODELS,
        describe: "Models to compare root tiles for when validating. 0 skips the tile check",
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "Overwrite an existing converted iModel",
      }) as never,
  handler: async (argv) => {
    const result = await runMapipulate({
      imodelPath: argv.imodelPath,
      remapType: argv.remapType,
      validate: argv.validate,
      tileModels: argv.tileModels,
      force: argv.force,
    });
    if (result.valid === false)
      process.exitCode = 1;
  },
};
