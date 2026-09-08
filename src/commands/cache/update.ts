import type { CommandModule } from "yargs";
import { startIModelHost } from "../../host/imodel-host";
import {
  fetchIModelDetails, listKnownIModelIds, upsertIModel, type IModelDetailsFetcher,
} from "../../cache/imodels";

export interface CacheUpdateArgs {
  /** Refresh only this iModel instead of every one the cache knows of. */
  imodelId?: string;
}

export interface CacheUpdateResult {
  /** iModels the details were fetched for. */
  updated: number;
  /** iModels whose details could not be fetched. */
  failed: { imodelId: string; reason: string }[];
}

/**
 * Fetch details from the iModels API for every iModel in the cache.
 *
 * Continues fetching if some fail.
 */
export async function runCacheUpdate(
  args: CacheUpdateArgs = {},
  fetch: IModelDetailsFetcher = fetchIModelDetails,
): Promise<CacheUpdateResult> {
  await startIModelHost();

  const imodelIds = args.imodelId ? [args.imodelId] : listKnownIModelIds();
  const result: CacheUpdateResult = { updated: 0, failed: [] };

  for (const imodelId of imodelIds) {
    try {
      upsertIModel(await fetch(imodelId));
      result.updated++;
    } catch (err) {
      result.failed.push({ imodelId, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

export const cacheUpdateCommand: CommandModule<unknown, CacheUpdateArgs> = {
  command: "update",
  describe: "Fetch iModel details from the iModels API for every iModel in the cache",
  builder: (y) =>
    y.option("imodel-id", {
      type: "string",
      describe: "Update only this iModel instead of every one in the cache",
    }) as never,
  handler: async (argv) => {
    const result = await runCacheUpdate({ imodelId: argv.imodelId });
    console.log(`Updated details for ${result.updated} iModel(s).`);
    for (const failure of result.failed)
      console.warn(`  ${failure.imodelId}: ${failure.reason}`);
    if (result.failed.length > 0)
      console.warn(`${result.failed.length} iModel(s) could not be updated.`);
  },
};
