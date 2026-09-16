import type { CommandModule } from "yargs";
import { getCacheDb } from "../../../cache/cache-db";

export interface CachedIModel {
  imodelId: string;
  name?: string;
  itwinId?: string;
  briefcases: { briefcaseId: number; filePath: string; changesetId: string | null }[];
  checkpoints: { changesetId: string; filePath: string }[];
}

export function runListImodels(): CachedIModel[] {
  const db = getCacheDb();
  const briefcaseRows = db
    .prepare("SELECT imodel_id, briefcase_id, file_path, changeset_id FROM downloaded_briefcases")
    .all() as { imodel_id: string; briefcase_id: number; file_path: string; changeset_id: string | null }[];
  const checkpointRows = db
    .prepare("SELECT imodel_id, changeset_id, file_path FROM downloaded_checkpoints")
    .all() as { imodel_id: string; changeset_id: string; file_path: string }[];

  const detailRows = db
    .prepare("SELECT imodel_id, itwin_id, name FROM imodels")
    .all() as { imodel_id: string; itwin_id: string; name: string }[];
  const details = new Map(detailRows.map((r) => [r.imodel_id, r]));

  const map = new Map<string, CachedIModel>();
  const ensure = (id: string) => {
    let v = map.get(id);
    if (!v) {
      const detail = details.get(id);
      v = { imodelId: id, name: detail?.name, itwinId: detail?.itwin_id, briefcases: [], checkpoints: [] };
      map.set(id, v);
    }
    return v;
  };
  for (const r of briefcaseRows)
    ensure(r.imodel_id).briefcases.push({
      briefcaseId: r.briefcase_id,
      filePath: r.file_path,
      changesetId: r.changeset_id,
    });
  for (const r of checkpointRows)
    ensure(r.imodel_id).checkpoints.push({ changesetId: r.changeset_id, filePath: r.file_path });

  return Array.from(map.values());
}

export const cacheListImodelsCommand: CommandModule = {
  command: "imodels",
  describe: "List all locally cached iModels",
  builder: (y) => y,
  handler: () => {
    const items = runListImodels();
    if (items.length === 0) {
      console.log("(no cached iModels)");
      return;
    }
    for (const item of items) {
      console.log(item.name ? `iModel ${item.imodelId}  ${item.name}` : `iModel ${item.imodelId}`);
      for (const b of item.briefcases)
        console.log(`  briefcase ${b.briefcaseId} (changeset ${b.changesetId ?? "?"}): ${b.filePath}`);
      for (const c of item.checkpoints)
        console.log(`  checkpoint ${c.changesetId}: ${c.filePath}`);
    }
  },
};
