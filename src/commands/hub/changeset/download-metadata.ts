import type { CommandModule } from "yargs";
import { startIModelHost } from "../../../host/imodel-host";
import { getHubAccess, getHubAuthorization } from "../../../host/hub-access";
import { highestCachedIndex, upsertChangesetMetadata, type CachedChangeset } from "../../../cache/changesets";
import { recordIModelDetails } from "../../../cache/imodels";
import { resolveCheckpointTarget, type IModelTargetArgs } from "../common";

/**
 * Changesets fetched per request.
 *
 * The API's maximum, and worth taking: measured against a 43,890 changeset iModel, paging at
 * 1000 read the whole history in 29s, where the client's default of 100 took 233s for the same
 * data -- 439 round trips instead of 44.
 */
const PAGE_SIZE = 1000;

/** How often progress is reported, in pages. */
const PROGRESS_EVERY_PAGES = 10;

export interface DownloadChangesetMetadataArgs extends IModelTargetArgs {
  /** First changeset index to fetch, inclusive. */
  start?: number;
  /** Last changeset index to fetch, inclusive. */
  end?: number;
  /** Fetch the whole history again rather than resuming after what is already cached. */
  refresh?: boolean;
}

export interface DownloadChangesetMetadataResult {
  imodelId: string;
  /** Changesets whose metadata was recorded. */
  recorded: number;
  /** Total size of those changesets' files, whether or not they are downloaded. */
  totalBytes: number;
  minIndex?: number;
  maxIndex?: number;
  /** Set when this run continued after changesets already cached. */
  resumedAfter?: number;
}

/**
 * Fetch changeset metadata from the iModels API and record it in the cache.
 *
 * Metadata only: no changeset files are downloaded. The whole history of a large iModel is
 * cheap to hold -- tens of seconds and a few megabytes of rows against tens of gigabytes of
 * files -- which is why this is a command of its own. `imod hub changeset download files` then
 * fetches whichever ranges are actually wanted, and can report their cost first because
 * `file_size` arrives with the metadata.
 *
 * Each page is written as it arrives rather than accumulated: the whole point is that this
 * scales to iModels with tens of thousands of changesets.
 */
export async function runDownloadChangesetMetadata(
  args: DownloadChangesetMetadataArgs,
): Promise<DownloadChangesetMetadataResult> {
  const { imodelId } = resolveChangesetTarget(args);
  await startIModelHost();

  const start = resolveStart(imodelId, args);
  const resumedAfter = start !== undefined && args.start === undefined ? start - 1 : undefined;

  const iterator = getHubAccess().iModelsClient.changesets.getRepresentationList({
    authorization: getHubAuthorization(),
    iModelId: imodelId,
    urlParams: {
      $top: PAGE_SIZE,
      // The hub's own filters: afterIndex is exclusive, lastIndex inclusive, so a --start of
      // 5 becomes afterIndex 4 and the range stays inclusive at both ends as the user wrote it.
      afterIndex: start === undefined ? undefined : start - 1,
      lastIndex: args.end,
    },
  });

  const result: DownloadChangesetMetadataResult = { imodelId, recorded: 0, totalBytes: 0, resumedAfter };
  let pages = 0;
  for await (const page of iterator.byPage()) {
    if (page.length === 0)
      continue;
    const changesets: CachedChangeset[] = page.map((changeset) => ({
      index: changeset.index,
      id: changeset.id,
      parentId: changeset.parentId ?? undefined,
      description: changeset.description ?? undefined,
      pushDateTime: changeset.pushDateTime,
      briefcaseId: changeset.briefcaseId,
      fileSize: changeset.fileSize,
      containingChanges: changeset.containingChanges,
      state: changeset.state,
      groupId: changeset.groupId ?? undefined,
      creatorId: changeset.creatorId,
    }));
    upsertChangesetMetadata(imodelId, changesets);

    result.recorded += changesets.length;
    for (const changeset of changesets) {
      result.totalBytes += changeset.fileSize;
      if (result.minIndex === undefined || changeset.index < result.minIndex)
        result.minIndex = changeset.index;
      if (result.maxIndex === undefined || changeset.index > result.maxIndex)
        result.maxIndex = changeset.index;
    }
    pages++;
    // One line per page would be hundreds on a large history, so this reports occasionally.
    if (pages % PROGRESS_EVERY_PAGES === 0)
      console.log(`Recorded ${result.recorded} changeset(s)...`);
  }

  return result;
}

/** Resolve the iModel, and record its details so the cache can name it later. */
function resolveChangesetTarget(args: IModelTargetArgs): { itwinId: string; imodelId: string } {
  return resolveCheckpointTarget(args);
}

/**
 * Where to start fetching: after what is already cached, unless told otherwise.
 *
 * A full history is hundreds of pages -- about seven minutes for half a million changesets --
 * and without this a run interrupted near the end starts again from the beginning. Changeset
 * metadata never changes once pushed, so resuming is safe: the timeline only ever grows.
 *
 * Only for a run with no range of its own. `--start` is honoured exactly, and `--refresh`
 * fetches everything again. Resuming is always announced, so it is never a silent skip.
 */
export function resolveStart(imodelId: string, args: DownloadChangesetMetadataArgs): number | undefined {
  if (args.start !== undefined || args.end !== undefined || args.refresh)
    return args.start;

  const highest = highestCachedIndex(imodelId);
  if (highest === undefined)
    return undefined;

  console.log(`Resuming after changeset index ${highest}; use --refresh to fetch the whole history again.`);
  return highest + 1;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2)
    return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export const downloadChangesetMetadataCommand: CommandModule<unknown, DownloadChangesetMetadataArgs> = {
  command: "metadata",
  describe: "Download changeset metadata into the cache. No changeset files are fetched",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", describe: "The iModel id (GUID)" })
      .option("itwin-id", { type: "string", describe: "The iTwin id (GUID) that owns the iModel" })
      .option("url", { type: "string", describe: "A URL containing the iTwin id then the iModel id" })
      .option("start", { type: "number", describe: "First changeset index to fetch, inclusive" })
      .option("end", { type: "number", describe: "Last changeset index to fetch, inclusive" })
      .option("refresh", {
        type: "boolean",
        default: false,
        describe: "Fetch the whole history again instead of resuming after what is cached",
      }) as never,
  handler: async (argv) => {
    const result = await runDownloadChangesetMetadata({
      imodelId: argv.imodelId,
      itwinId: argv.itwinId,
      url: argv.url,
      start: argv.start,
      end: argv.end,
      refresh: argv.refresh,
    });
    if (result.recorded === 0) {
      // Nothing new after a resume is the normal, happy case, and reads nothing like an empty
      // range that the user asked for and did not get.
      console.log(
        result.resumedAfter === undefined
          ? "No changesets found for that range."
          : `Already up to date: nothing newer than changeset index ${result.resumedAfter}.`,
      );
      return;
    }
    console.log(
      `Recorded metadata for ${result.recorded} changeset(s), index ${result.minIndex}..${result.maxIndex}.`,
    );
    console.log(`Their files total ${formatBytes(result.totalBytes)}; none were downloaded.`);
    console.log(`Download them with: imod hub changeset download files --imodel-id ${result.imodelId} --start <n> --end <n>`);
    await recordIModelDetails(result.imodelId);
  },
};
