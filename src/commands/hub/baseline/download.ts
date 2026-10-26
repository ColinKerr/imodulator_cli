import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandModule } from "yargs";
import { downloadFile, type BaselineFile } from "@itwin/imodels-client-authoring";
import { startIModelHost } from "../../../host/imodel-host";
import { createDownloadProgress } from "../../../host/download-progress";
import { getHubAccess, getHubAuthorization } from "../../../host/hub-access";
import { ReportingUploadClientStorage } from "../../../host/upload-storage";
import { getCacheDb } from "../../../cache/cache-db";
import { ensureIModelCacheDir } from "../../../cache/cache-dir";
import { recordIModelDetails } from "../../../cache/imodels";
import { resolveCheckpointTarget, type IModelTargetArgs } from "../common";
import { formatBytes } from "../changeset/download-metadata";

export type DownloadBaselineArgs = IModelTargetArgs;

export interface DownloadBaselineResult {
  imodelId: string;
  filePath: string;
  fileSize: number;
  /** False when a complete copy was already in the cache and nothing was fetched. */
  downloaded: boolean;
}

/**
 * The hub calls this command makes, so a test can stand in for them: HubMock has no
 * `iModelsClient`, which is where the baseline file operation lives.
 */
export interface BaselineHub {
  getBaseline(imodelId: string): Promise<BaselineFile>;
  /** Fetch a storage link to a local file, reporting bytes as they arrive. */
  download(link: { href: string; storageType: string }, localPath: string, onBytes: (n: number) => void): Promise<void>;
  recordDetails(imodelId: string): Promise<void>;
}

const hubBaseline: BaselineHub = {
  getBaseline: async (imodelId) =>
    getHubAccess().iModelsClient.baselineFiles.getSingle({ authorization: getHubAuthorization(), iModelId: imodelId }),
  download: async (link, localPath, onBytes) =>
    downloadFile({
      // The same storage the hub access uses: it wraps the Azure and Google clients and passes
      // downloads straight through.
      storage: new ReportingUploadClientStorage(),
      url: link.href,
      storageType: link.storageType,
      localPath,
      latestDownloadedChunkSizeCallback: onBytes,
    }),
  recordDetails: async (imodelId) => {
    await recordIModelDetails(imodelId);
  },
};

/** Where an iModel's baseline lives in the cache. */
export function baselineFilePath(imodelId: string): string {
  return path.join(ensureIModelCacheDir(imodelId), "baseline", `${imodelId}_baseline.bim`);
}

/** Only the iModel id is needed, so `--imodel-id` alone works even for an iModel the cache has not seen. */
function resolveIModelId(args: DownloadBaselineArgs): string {
  if (args.url)
    return resolveCheckpointTarget(args).imodelId;
  if (args.imodelId)
    return args.imodelId;
  throw new Error("Provide --imodel-id or --url");
}

/**
 * Download an iModel's baseline file -- the file it was created from, before any changeset --
 * into the cache, and record it.
 *
 * A baseline never changes once the iModel exists, so a file already in the cache at the size
 * the hub reports is kept and nothing is fetched. The download goes to a temporary name and is
 * checked against that size before it is moved into place, so an interrupted or short download
 * never leaves a file that looks complete.
 */
export async function runDownloadBaseline(
  args: DownloadBaselineArgs,
  hub: BaselineHub = hubBaseline,
): Promise<DownloadBaselineResult> {
  const imodelId = resolveIModelId(args);
  await startIModelHost();

  const baseline = await hub.getBaseline(imodelId);
  const link = baseline._links.download;
  if (baseline.state !== "initialized" || link === null)
    throw new Error(
      `The baseline file of iModel ${imodelId} cannot be downloaded: its state is "${baseline.state}"` +
      (link === null ? " and it has no download link." : "."),
    );

  const filePath = baselineFilePath(imodelId);
  const result: DownloadBaselineResult = { imodelId, filePath, fileSize: baseline.fileSize, downloaded: false };

  if (fs.statSync(filePath, { throwIfNoEntry: false })?.size !== baseline.fileSize) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    const progress = createDownloadProgress(`Downloading baseline for iModel ${imodelId}`);
    let loaded = 0;
    try {
      await hub.download(link, tempPath, (n) => {
        loaded += n;
        progress(loaded, baseline.fileSize);
      });
      const size = fs.statSync(tempPath).size;
      if (size !== baseline.fileSize)
        throw new Error(`Downloaded ${size} bytes of the baseline, but the hub reports ${baseline.fileSize}.`);
    } catch (err) {
      fs.rmSync(tempPath, { force: true });
      throw err;
    }
    fs.renameSync(tempPath, filePath);
    result.downloaded = true;
  }

  getCacheDb()
    .prepare(
      `INSERT OR REPLACE INTO downloaded_baselines (imodel_id, baseline_id, file_size, file_path)
       VALUES (?, ?, ?, ?)`,
    )
    .run(imodelId, baseline.id, baseline.fileSize, filePath);
  await hub.recordDetails(imodelId);

  return result;
}

export const downloadBaselineCommand: CommandModule<unknown, DownloadBaselineArgs> = {
  command: "download",
  describe: "Download the iModel's baseline file, the file it was created from before any changeset",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", describe: "The iModel id (GUID). Ignored if --url is set" })
      .option("itwin-id", { type: "string", describe: "The iTwin id (GUID). Not needed; accepted for consistency" })
      .option("url", { type: "string", describe: "A URL containing the iTwin id then the iModel id" }) as never,
  handler: async (argv) => {
    const result = await runDownloadBaseline({ imodelId: argv.imodelId, itwinId: argv.itwinId, url: argv.url });
    console.log(
      result.downloaded
        ? `Downloaded the baseline (${formatBytes(result.fileSize)}) to ${result.filePath}`
        : `The baseline (${formatBytes(result.fileSize)}) is already in the cache at ${result.filePath}`,
    );
  },
};
