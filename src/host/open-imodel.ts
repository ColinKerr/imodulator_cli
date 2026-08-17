import * as fs from "node:fs";
import { SnapshotDb, StandaloneDb, type IModelDb } from "@itwin/core-backend";
import { OpenMode } from "@itwin/core-bentley";

/**
 * Open a local iModel read-only.
 *
 * Local iModels are a mix of checkpoints and briefcases: SnapshotDb handles checkpoints and
 * briefcases fall back to StandaloneDb. Never opened writable, so nothing here can perturb
 * what it is measuring.
 */
export function openReadonly(fileName: string, key: string): IModelDb {
  if (!fs.existsSync(fileName))
    throw new Error(`iModel file not found: ${fileName}`);

  try {
    return SnapshotDb.openFile(fileName, { key: `${key}#snapshot` });
  } catch (snapshotError) {
    try {
      // OpenMode must be passed explicitly: StandaloneDb.openFile defaults to ReadWrite.
      return StandaloneDb.openFile(fileName, OpenMode.Readonly, { key: `${key}#standalone` });
    } catch {
      throw snapshotError;
    }
  }
}
