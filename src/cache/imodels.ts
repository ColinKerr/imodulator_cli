import { getCacheDb } from "./cache-db";
import { getHubAccess, getHubAuthorization } from "../host/hub-access";

/** What the cache keeps about an iModel, from the iModels API. */
export interface CachedIModelDetails {
  imodelId: string;
  itwinId: string;
  name: string;
  displayName?: string;
  description?: string;
}

export function upsertIModel(details: CachedIModelDetails): void {
  getCacheDb()
    .prepare(
      `INSERT OR REPLACE INTO imodels (imodel_id, itwin_id, name, display_name, description)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      details.imodelId,
      details.itwinId,
      details.name,
      details.displayName ?? null,
      details.description ?? null,
    );
}

export function getCachedIModel(imodelId: string): CachedIModelDetails | undefined {
  const row = getCacheDb()
    .prepare("SELECT imodel_id, itwin_id, name, display_name, description FROM imodels WHERE imodel_id = ?")
    .get(imodelId) as
    | { imodel_id: string; itwin_id: string; name: string; display_name: string | null; description: string | null }
    | undefined;
  if (!row)
    return undefined;
  return {
    imodelId: row.imodel_id,
    itwinId: row.itwin_id,
    name: row.name,
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
  };
}

/**
 * Every iModel the cache knows of, from any table that names one.
 *
 * An iModel reaches the cache by several routes -- a downloaded briefcase, a checkpoint, a
 * manifest, an acquired briefcase id -- and any of them is reason enough to hold its details.
 */
export function listKnownIModelIds(): string[] {
  const rows = getCacheDb()
    .prepare(
      `SELECT imodel_id FROM downloaded_briefcases
       UNION SELECT imodel_id FROM downloaded_checkpoints
       UNION SELECT imodel_id FROM downloaded_manifests
       UNION SELECT imodel_id FROM briefcase_ids
       UNION SELECT imodel_id FROM imodels
       ORDER BY imodel_id`,
    )
    .all() as { imodel_id: string }[];
  return rows.map((row) => row.imodel_id);
}

/** How details are obtained, so a caller can supply them from somewhere other than the API. */
export type IModelDetailsFetcher = (imodelId: string) => Promise<CachedIModelDetails>;

/** Ask the iModels API what it knows about an iModel. */
export async function fetchIModelDetails(imodelId: string): Promise<CachedIModelDetails> {
  const imodel = await getHubAccess().iModelsClient.iModels.getSingle({
    authorization: getHubAuthorization(),
    iModelId: imodelId,
  });
  return {
    imodelId: imodel.id,
    itwinId: imodel.iTwinId,
    name: imodel.name,
    displayName: imodel.displayName,
    description: imodel.description ?? undefined,
  };
}

/**
 * Fetch an iModel's details and record them, reporting rather than throwing on failure.
 *
 * Called after a command has already done its real work -- downloaded a briefcase, acquired an
 * id -- where metadata that could not be fetched leaves the cache poorer but the command's
 * result intact. `imod cache update` fills in anything missed.
 */
export async function recordIModelDetails(
  imodelId: string,
  fetch: IModelDetailsFetcher = fetchIModelDetails,
): Promise<CachedIModelDetails | undefined> {
  try {
    const details = await fetch(imodelId);
    upsertIModel(details);
    return details;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Could not record details for iModel ${imodelId}: ${message}`);
    console.warn(`Run "imod cache update" to try again.`);
    return undefined;
  }
}
