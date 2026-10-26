import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandModule } from "yargs";
import { BriefcaseManager } from "@itwin/core-backend";
import { startIModelHost } from "../../host/imodel-host";
import { listIModelsWithChangesets } from "../../cache/changesets";
import {
  repairChangesetFiles, unknownChangesetIds, type ChangesetRepairResult,
} from "../../cache/changeset-files";
import { runDownloadChangesetMetadata } from "../hub/changeset/download-metadata";

export interface RepairChangesetsArgs {
  /** Repair only this iModel instead of every one found. */
  imodelId?: string;
  /** Never ask the hub for metadata; files it would be needed for are reported as unknown. */
  offline?: boolean;
}

export interface RepairChangesetsResult {
  repaired: ChangesetRepairResult[];
  /** iModels whose metadata could not be fetched; their known files are still repaired. */
  metadataFailed: { imodelId: string; reason: string }[];
}

/** Fetch changeset metadata for an iModel. `refresh` fetches the whole history again. */
export type ChangesetMetadataFetcher = (imodelId: string, refresh: boolean) => Promise<void>;

const fetchFromHub: ChangesetMetadataFetcher = async (imodelId, refresh) => {
  await runDownloadChangesetMetadata({ imodelId, refresh });
};

/**
 * iModels with something to repair: a changeset directory on disk, or changeset rows in the db.
 *
 * Both, because each side can be the one that is out of date: files kept from an earlier cache
 * db, or rows pointing at files that were deleted.
 */
export function findIModelsWithChangesets(): string[] {
  const ids = new Set(listIModelsWithChangesets());
  const imodelsDir = BriefcaseManager.cacheDir;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(imodelsDir, { withFileTypes: true });
  } catch {
    // No iModels directory: nothing has been downloaded.
  }
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue;
    const dir = path.join(imodelsDir, entry.name);
    if (fs.existsSync(path.join(dir, "changeset-cache")) || fs.existsSync(path.join(dir, "changesets")))
      ids.add(entry.name);
  }
  return [...ids].sort();
}

/**
 * Bring the cache db and the changeset directories back into agreement.
 *
 * For each iModel: fetch metadata for files it has none for (resuming first, then the whole
 * history if that was not enough), then `repairChangesetFiles`. No changeset file is downloaded.
 */
export async function runRepairChangesets(
  args: RepairChangesetsArgs = {},
  fetchMetadata: ChangesetMetadataFetcher = fetchFromHub,
): Promise<RepairChangesetsResult> {
  await startIModelHost();

  const imodelIds = args.imodelId ? [args.imodelId] : findIModelsWithChangesets();
  const result: RepairChangesetsResult = { repaired: [], metadataFailed: [] };

  for (const imodelId of imodelIds) {
    if (!args.offline && unknownChangesetIds(imodelId).length > 0) {
      try {
        await fetchMetadata(imodelId, false);
        // Resuming only fetches past the highest index held, so files from before a ranged
        // fetch are still unknown; only the whole history finds them.
        if (unknownChangesetIds(imodelId).length > 0)
          await fetchMetadata(imodelId, true);
      } catch (err) {
        result.metadataFailed.push({ imodelId, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    result.repaired.push(repairChangesetFiles(imodelId));
  }

  return result;
}

export const cacheRepairChangesetsCommand: CommandModule<unknown, RepairChangesetsArgs> = {
  command: "repair-changesets",
  describe: "Record changeset files already on disk in the cache db, and relink iTwin.js's changesets directory",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", describe: "Repair only this iModel instead of every one found" })
      .option("offline", {
        type: "boolean",
        default: false,
        describe: "Do not fetch missing changeset metadata from the hub",
      }) as never,
  handler: async (argv) => {
    const result = await runRepairChangesets({ imodelId: argv.imodelId, offline: argv.offline });
    if (result.repaired.length === 0) {
      console.log("No changeset files or changeset metadata in the cache.");
      return;
    }
    for (const r of result.repaired) {
      console.log(
        `${r.imodelId}: ${r.filesOnDisk} file(s) on disk; ${r.recorded} newly recorded, ${r.adopted} adopted, ` +
        `${r.relinked} relinked, ${r.cleared} missing file(s) cleared.`,
      );
      if (r.unknown.length > 0)
        console.warn(`  ${r.unknown.length} file(s) have no metadata and were not recorded, e.g. ${r.unknown[0]}.`);
      if (r.wrongSize.length > 0)
        console.warn(
          `  ${r.wrongSize.length} file(s) are not the expected size and were not recorded, e.g. ${r.wrongSize[0]}.`,
        );
    }
    for (const failure of result.metadataFailed)
      console.warn(`Could not fetch metadata for ${failure.imodelId}: ${failure.reason}`);
  },
};
