import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import * as path from "node:path";
import type { V2CheckpointAccessProps } from "@itwin/core-backend";
import { startIModelHost } from "../../../host/imodel-host";
import { getHubAccess } from "../../../host/hub-access";
import { getCacheDb } from "../../../cache/cache-db";
import { ensureIModelCacheDir } from "../../../cache/cache-dir";
import { resolveCheckpointTarget, type IModelTargetArgs } from "../common";

/** Name of the Cloud Backed SQLite manifest blob, at the root of an iModel's container. */
export const MANIFEST_FILE_NAME = "manifest.bcv";

export interface DownloadManifestArgs extends IModelTargetArgs {
  /** Download a fresh copy when the cached manifest is out of date. */
  update?: boolean;
}

export type ManifestStatus =
  /** A new copy was downloaded. */
  | "downloaded"
  /** The cached copy already matches the one in the container. */
  | "upToDate"
  /** The cached copy is out of date and `--update` was not passed, so it was left alone. */
  | "stale";

export interface DownloadManifestResult {
  filePath: string;
  status: ManifestStatus;
}

/**
 * The manifest is a plain blob at the root of the iModel's container, and CloudSqlite has
 * no API that downloads it to a named file -- the native VFS fetches it implicitly. So the
 * blob is read directly, using the coordinates `queryV2Checkpoint` hands out.
 */
export function buildManifestUrl(v2props: V2CheckpointAccessProps): string {
  // core builds checkpoint container URIs the same way and hardcodes azure, see
  // CheckpointManager.toCloudContainerProps. storageType may carry URI-style parameters,
  // hence the prefix test rather than an equality check.
  if (!v2props.storageType.toLowerCase().startsWith("azure"))
    throw new Error(
      `Cannot build a manifest URL for storage type '${v2props.storageType}'; only azure blob containers are supported.`,
    );
  const sasToken = v2props.sasToken.startsWith("?") ? v2props.sasToken.slice(1) : v2props.sasToken;
  return `https://${v2props.accountName}.blob.core.windows.net/${v2props.containerId}/${MANIFEST_FILE_NAME}?${sasToken}`;
}

export interface ManifestCacheState {
  /** ETag recorded when the cached manifest was downloaded, if any. */
  cachedEtag?: string;
  /** Whether the cached manifest is still on disk. */
  fileExists: boolean;
  /** ETag currently reported by the container, if it could be read. */
  remoteEtag?: string;
  update?: boolean;
}

/** What to do about the cached manifest, given what the container reports. */
export function decideManifestAction(state: ManifestCacheState): "download" | "upToDate" | "stale" {
  if (!state.fileExists)
    return "download";
  // Without both ETags the cached copy cannot be shown to be current, so treat it as
  // out of date rather than claim it is good.
  if (!state.cachedEtag || !state.remoteEtag)
    return state.update ? "download" : "stale";
  if (state.cachedEtag === state.remoteEtag)
    return "upToDate";
  return state.update ? "download" : "stale";
}

export async function runDownloadManifest(args: DownloadManifestArgs): Promise<DownloadManifestResult> {
  const { itwinId, imodelId } = resolveCheckpointTarget(args);

  await startIModelHost();

  const url = buildManifestUrl(await queryCheckpointContainer(itwinId, imodelId));
  const filePath = path.join(ensureIModelCacheDir(imodelId), MANIFEST_FILE_NAME);
  const fileExists = fs.existsSync(filePath);

  const cached = getCacheDb()
    .prepare("SELECT etag FROM downloaded_manifests WHERE imodel_id = ?")
    .get(imodelId) as { etag: string | null } | undefined;

  // Only worth asking the container when there is something to compare against.
  const remoteEtag = fileExists ? await queryRemoteEtag(url) : undefined;

  const action = decideManifestAction({
    cachedEtag: cached?.etag ?? undefined,
    fileExists,
    remoteEtag,
    update: args.update,
  });
  if (action !== "download")
    return { filePath, status: action };

  const etag = await downloadManifest(url, filePath);
  getCacheDb()
    .prepare("INSERT OR REPLACE INTO downloaded_manifests (imodel_id, file_path, etag) VALUES (?, ?, ?)")
    .run(imodelId, filePath, etag ?? null);
  return { filePath, status: "downloaded" };
}

/** Container coordinates for the iModel. The changeset only selects a checkpoint to ask. */
async function queryCheckpointContainer(iTwinId: string, iModelId: string): Promise<V2CheckpointAccessProps> {
  const changeset = await getHubAccess().getLatestChangeset({ iModelId });
  const v2props = await getHubAccess().queryV2Checkpoint({
    iTwinId,
    iModelId,
    changeset: { id: changeset.id, index: changeset.index },
    // The newest changeset may not have a checkpoint of its own; any checkpoint in the
    // container points at the same manifest.
    allowPreceding: true,
  });
  if (!v2props)
    throw new Error(
      `iModel ${iModelId} has no V2 checkpoint, so there is no cloud container to read a manifest from.`,
    );
  return v2props;
}

/** The container's current ETag, or undefined when it cannot be read. */
async function queryRemoteEtag(url: string): Promise<string | undefined> {
  const response = await fetch(url, { method: "HEAD" });
  // Some container policies reject HEAD. That is not fatal: without an ETag the cached
  // copy is simply treated as unverified.
  if (!response.ok)
    return undefined;
  return response.headers.get("etag") ?? undefined;
}

/** Fetch the manifest blob and return the ETag it was served with. */
async function downloadManifest(url: string, filePath: string): Promise<string | undefined> {
  const response = await fetch(url);
  if (!response.ok) {
    const hint = response.status === 403 ? " The container token may have expired; run the command again." : "";
    throw new Error(`Failed to download ${MANIFEST_FILE_NAME}: HTTP ${response.status} ${response.statusText}.${hint}`);
  }
  fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
  return response.headers.get("etag") ?? undefined;
}

export const downloadManifestCommand: CommandModule<unknown, DownloadManifestArgs> = {
  command: "download",
  describe: "Download the Cloud Backed SQLite manifest for an iModel into the cache",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", describe: "The iModel id (GUID). Ignored if --url is set" })
      .option("itwin-id", { type: "string", describe: "The iTwin id (GUID) that owns the iModel. Ignored if --url is set" })
      .option("url", { type: "string", describe: "A URL containing the iTwin id then the iModel id; replaces --itwin-id and --imodel-id" })
      .option("update", {
        type: "boolean",
        default: false,
        describe: "Download a fresh copy when the cached manifest is out of date",
      })
      .check((argv) => {
        if (!argv.url && !(argv["itwin-id"] && argv["imodel-id"]))
          throw new Error("Provide --url, or both --itwin-id and --imodel-id");
        return true;
      }) as never,
  handler: async (argv) => {
    const result = await runDownloadManifest({
      imodelId: argv.imodelId,
      itwinId: argv.itwinId,
      url: argv.url,
      update: argv.update,
    });
    switch (result.status) {
      case "downloaded":
        console.log(`Downloaded manifest to ${result.filePath}`);
        break;
      case "upToDate":
        console.log(`Cached manifest is up to date: ${result.filePath}`);
        break;
      case "stale":
        console.log(`Cached manifest is out of date: ${result.filePath}`);
        console.log("Re-run with --update to download a fresh copy.");
        break;
    }
  },
};
