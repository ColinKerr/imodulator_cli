import type { CommandModule } from "yargs";
import * as path from "node:path";
import { BriefcaseManager } from "@itwin/core-backend";
import { BriefcaseIdValue, IModelVersion } from "@itwin/core-common";
import { startIModelHost } from "../../../host/imodel-host";
import { getHubAccess } from "../../../host/hub-access";
import { getAccessToken } from "../../../auth/auth-client";
import { getCacheDb } from "../../../cache/cache-db";
import { ensureIModelCacheDir } from "../../../cache/cache-dir";

export interface DownloadCheckpointArgs {
  imodelId?: string;
  itwinId?: string;
  url?: string;
  changesetId?: string;
}

const GUID_REGEX = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * Resolve the iTwin and iModel ids from either an explicit `--url` or the
 * `--itwin-id`/`--imodel-id` pair. When `--url` is supplied it takes precedence;
 * its first GUID is the iTwin id and its second is the iModel id.
 */
export function resolveCheckpointTarget(args: DownloadCheckpointArgs): {
  itwinId: string;
  imodelId: string;
} {
  if (args.url) {
    const [itwinId, imodelId] = args.url.match(GUID_REGEX) ?? [];
    if (!itwinId || !imodelId)
      throw new Error(`--url must contain two GUIDs (iTwin id then iModel id): ${args.url}`);
    return { itwinId, imodelId };
  }
  if (!args.itwinId || !args.imodelId)
    throw new Error("Provide --url, or both --itwin-id and --imodel-id");
  return { itwinId: args.itwinId, imodelId: args.imodelId };
}

export async function runDownloadCheckpoint(args: DownloadCheckpointArgs): Promise<string> {
  const { itwinId, imodelId } = resolveCheckpointTarget(args);

  await startIModelHost();
  console.log(`Starting download of checkpoint for iModel ${imodelId}...`);
  const accessToken = await getAccessToken();

  const changeset = args.changesetId
    ? { id: args.changesetId }
    : await getHubAccess().getLatestChangeset({ iModelId: imodelId });

  const targetDir = path.join(ensureIModelCacheDir(imodelId), "checkpoints");
  const fileName = path.join(targetDir, `${imodelId}_${changeset.id}.bim`);

  console.log(`Downloading checkpoint for iModel ${imodelId} at changeset ${changeset.id} to ${fileName}...`);

  const props = await BriefcaseManager.downloadBriefcase({
    accessToken,
    iTwinId: itwinId,
    iModelId: imodelId,
    briefcaseId: BriefcaseIdValue.Unassigned,
    fileName,
    asOf: IModelVersion.asOfChangeSet(changeset.id).toJSON(),
  });

  getCacheDb()
    .prepare(
      "INSERT OR REPLACE INTO downloaded_checkpoints (imodel_id, changeset_id, file_path) VALUES (?, ?, ?)",
    )
    .run(imodelId, changeset.id, props.fileName);

  return props.fileName;
}

export const downloadCheckpointCommand: CommandModule<unknown, DownloadCheckpointArgs> = {
  command: "download",
  describe: "Download a read-only checkpoint for the iModel",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", describe: "The iModel id (GUID). Ignored if --url is set" })
      .option("itwin-id", { type: "string", describe: "The iTwin id (GUID) that owns the iModel. Ignored if --url is set" })
      .option("url", { type: "string", describe: "A URL containing the iTwin id then the iModel id; replaces --itwin-id and --imodel-id" })
      .option("changeset-id", { type: "string", describe: "Specific changeset id to checkpoint (defaults to latest)" })
      .check((argv) => {
        if (!argv.url && !(argv["itwin-id"] && argv["imodel-id"]))
          throw new Error("Provide --url, or both --itwin-id and --imodel-id");
        return true;
      }) as never,
  handler: async (argv) => {
    const file = await runDownloadCheckpoint({
      imodelId: argv.imodelId,
      itwinId: argv.itwinId,
      url: argv.url,
      changesetId: argv.changesetId,
    });
    console.log(`Downloaded checkpoint to ${file}`);
  },
};
