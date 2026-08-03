import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import * as path from "node:path";
import { getIModelCacheDir } from "../../../cache/cache-dir";
import { formatTable, type TableData } from "../../../format/table";
import { parseManifest, type ManifestInfo } from "../../../manifest/manifest-file";
import { MANIFEST_FILE_NAME } from "./download";

export interface ListManifestArgs {
  imodelId?: string;
  /** Read this manifest file instead of the one cached for `--imodel-id`. */
  manifestPath?: string;
}

export interface ListManifestResult {
  filePath: string;
  manifest: ManifestInfo;
}

/** The manifest to read: an explicit path wins, otherwise the one cached for the iModel. */
export function resolveManifestPath(args: ListManifestArgs): string {
  if (args.manifestPath) {
    if (!fs.existsSync(args.manifestPath))
      throw new Error(`Manifest file not found: ${args.manifestPath}`);
    return args.manifestPath;
  }

  if (!args.imodelId)
    throw new Error("Provide --imodel-id, or --manifest-path");

  const filePath = path.join(getIModelCacheDir(args.imodelId), MANIFEST_FILE_NAME);
  if (!fs.existsSync(filePath))
    throw new Error(
      `No manifest cached for iModel ${args.imodelId}. Download one first with: imod hub manifest download --imodel-id ${args.imodelId}`,
    );
  return filePath;
}

export function runListManifest(args: ListManifestArgs): ListManifestResult {
  const filePath = resolveManifestPath(args);
  return { filePath, manifest: parseManifest(fs.readFileSync(filePath)) };
}

/** One row per database, with deleted databases marked rather than hidden. */
export function toDatabaseTable(manifest: ManifestInfo): TableData {
  return {
    columns: ["database", "id", "parent", "version", "blocks", "state"],
    rows: manifest.databases.map((db) => [
      db.name,
      db.id,
      db.parentId === 0 ? "" : db.parentId,
      db.version,
      db.blockCount,
      db.deleted ? "deleted" : "",
    ]),
  };
}

export function summarize(manifest: ManifestInfo): string {
  return [
    `manifest version ${manifest.version}`,
    `block size ${manifest.blockSize} bytes`,
    `block id size ${manifest.nameSize} bytes`,
    `${manifest.databases.length} database(s)`,
    `${manifest.deleteEntryCount} block(s) on the delete list`,
  ].join(", ");
}

export const listManifestCommand: CommandModule<unknown, ListManifestArgs> = {
  command: "list",
  describe: "List the databases described by an iModel's Cloud Backed SQLite manifest",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", describe: "The iModel id (GUID) whose cached manifest to read" })
      .option("manifest-path", { type: "string", describe: "Path to a manifest file to read instead of the cached one" })
      .check((argv) => {
        if (!argv["manifest-path"] && !argv["imodel-id"])
          throw new Error("Provide --imodel-id, or --manifest-path");
        return true;
      }) as never,
  handler: (argv) => {
    const { filePath, manifest } = runListManifest({
      imodelId: argv.imodelId,
      manifestPath: argv.manifestPath,
    });
    console.log(filePath);
    console.log(summarize(manifest));
    if (manifest.databases.length === 0) {
      console.log("(no databases)");
      return;
    }
    console.log(formatTable(toDatabaseTable(manifest)));
  },
};
