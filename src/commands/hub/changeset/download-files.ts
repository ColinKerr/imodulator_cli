import type { CommandModule } from "yargs";
import { BriefcaseManager } from "@itwin/core-backend";
import { startIModelHost } from "../../../host/imodel-host";
import { createDownloadProgress } from "../../../host/download-progress";
import { recordChangesetFiles, summarizeChangesets, type ChangesetRange } from "../../../cache/changesets";
import { keepChangesetFile, restoreChangesetFiles } from "../../../cache/changeset-files";
import { resolveCheckpointTarget, type IModelTargetArgs } from "../common";
import { formatBytes, runDownloadChangesetMetadata } from "./download-metadata";

/**
 * Changesets fetched per round of downloading.
 *
 * The client holds every changeset of the range it is given in one array, so the range handed
 * to it is bounded rather than passed straight through from the user.
 */
const DOWNLOAD_CHUNK = 1000;

export interface DownloadChangesetFilesArgs extends IModelTargetArgs {
  /** First changeset index to download, inclusive. */
  start?: number;
  /** Last changeset index to download, inclusive. */
  end?: number;
}

export interface DownloadChangesetFilesResult {
  imodelId: string;
  /** Changesets whose file is on disk after this ran, including ones already there. */
  downloaded: number;
  /** Bytes the range holds in total. */
  totalBytes: number;
  targetDir: string;
}

/**
 * Download the changeset files for a range, and record where each one landed.
 *
 * Ranged by design. A large iModel's history runs to tens of gigabytes, so downloading all of
 * it is rarely what anyone wants; the metadata command holds the whole timeline cheaply and
 * this fetches the parts that are needed.
 *
 * Already-downloaded changesets cost nothing to ask for again: the client compares the file's
 * size against the expected size and skips it, and re-downloads only a file that is missing or
 * the wrong size. An interrupted download therefore resumes by being run again.
 */
export async function runDownloadChangesetFiles(
  args: DownloadChangesetFilesArgs,
): Promise<DownloadChangesetFilesResult> {
  const { imodelId } = resolveCheckpointTarget(args);
  await startIModelHost();

  const range: ChangesetRange = { start: args.start, end: args.end };

  // The metadata is what says how big the range is and which indexes exist, so fetch it for
  // this range if it is not already held.
  if (summarizeChangesets(imodelId, range).count === 0) {
    console.log("No changeset metadata cached for that range; fetching it first...");
    await runDownloadChangesetMetadata({ ...args, imodelId });
  }

  const summary = summarizeChangesets(imodelId, range);
  if (summary.count === 0)
    throw new Error(`No changesets found for iModel ${imodelId} in that range.`);

  const targetDir = BriefcaseManager.getChangeSetsPath(imodelId);
  console.log(
    `Downloading ${summary.count} changeset(s), index ${summary.minIndex}..${summary.maxIndex}: ` +
    `${formatBytes(summary.totalBytes)} in total, ${formatBytes(summary.missingBytes)} still to fetch ` +
    `(${summary.withFile} already downloaded).`,
  );

  // Downloaded a chunk at a time rather than as one range. The client accumulates every
  // changeset in the range it is given into a single array before returning
  // (`ChangesetOperations.downloadList`, `result = result.concat(...)` per page), so a range of
  // hundreds of thousands would be held in memory at once, and nothing would be recorded until
  // all of it had finished. Chunking bounds that and makes an interrupted download keep what it
  // already got.
  const progress = createDownloadProgress(`Downloading changesets for iModel ${imodelId}`);
  for (let first = summary.minIndex!; first <= summary.maxIndex!; first += DOWNLOAD_CHUNK) {
    const end = Math.min(first + DOWNLOAD_CHUNK - 1, summary.maxIndex!);

    // Anything still kept but missing from iTwin.js's directory is linked back first, so the
    // client's skip finds it and downloads nothing. Otherwise every changeset a checkpoint
    // download consumed would be fetched again.
    const restored = restoreChangesetFiles(imodelId, { start: first, end });
    if (restored > 0)
      console.log(`Restored ${restored} changeset file(s) already held, which will not be downloaded again.`);

    const downloaded = await BriefcaseManager.downloadChangesets({
      iModelId: imodelId,
      range: { first, end },
      targetDir,
      progressCallback: progress,
    });

    // Each file gets a second name in the keep directory, and that is the name the cache
    // records: iTwin.js deletes its own copy when it applies a changeset, and the kept name is
    // what makes that harmless. Recorded in one transaction per chunk, since a statement at a
    // time costs about 2.5x as much.
    recordChangesetFiles(
      imodelId,
      downloaded.map((changeset) => ({
        changesetIndex: changeset.index,
        filePath: keepChangesetFile(imodelId, changeset.id, changeset.pathname),
      })),
    );
  }

  return {
    imodelId,
    downloaded: summarizeChangesets(imodelId, range).withFile,
    totalBytes: summary.totalBytes,
    targetDir,
  };
}

export const downloadChangesetFilesCommand: CommandModule<unknown, DownloadChangesetFilesArgs> = {
  command: "files",
  describe: "Download changeset files for a range of changesets into the cache",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", describe: "The iModel id (GUID)" })
      .option("itwin-id", { type: "string", describe: "The iTwin id (GUID) that owns the iModel" })
      .option("url", { type: "string", describe: "A URL containing the iTwin id then the iModel id" })
      .option("start", { type: "number", describe: "First changeset index to download, inclusive" })
      .option("end", { type: "number", describe: "Last changeset index to download, inclusive" }) as never,
  handler: async (argv) => {
    const result = await runDownloadChangesetFiles({
      imodelId: argv.imodelId,
      itwinId: argv.itwinId,
      url: argv.url,
      start: argv.start,
      end: argv.end,
    });
    console.log(`${result.downloaded} changeset file(s) in ${result.targetDir}.`);
  },
};
