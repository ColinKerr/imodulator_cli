import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BriefcaseDb, EditTxn, type IModelDb } from "@itwin/core-backend";
import { DbResult, type Id64String } from "@itwin/core-bentley";
import { startIModelHost } from "../../../host/imodel-host";

/** Duplicate identities cleared per transaction. */
const BATCH_SIZE = 5000;

export interface CleanEsaArgs {
  imodelPath: string;
  /** Report the duplicates without deleting anything. */
  dryRun?: boolean;
}

export interface CleanEsaResult {
  /** ExternalSourceAspects examined. */
  scanned: number;
  /** Identities that had more than one aspect. */
  duplicateGroups: number;
  /** Aspects in excess of one per identity. */
  redundant: number;
  /** Aspects actually deleted; 0 for a dry run. */
  deleted: number;
  /** Aspects in the largest duplicate group. */
  largestGroup: number;
}

/** Where ExternalSourceAspect's identity properties physically live in this iModel. */
interface EsaStorage {
  classId: number;
  table: string;
  scope: string;
  identifier: string;
  kind: string;
  jsonProperties: string;
}

/** One identity that holds duplicates, and the aspect that will be kept. */
interface DuplicateGroup {
  elementId: Id64String;
  scope: string | undefined;
  identifier: string | undefined;
  kind: string | undefined;
  jsonProperties: string | undefined;
  keeperId: Id64String;
  count: number;
}

/**
 * Resolve the physical storage of the identity properties.
 *
 * ExternalSourceAspect's properties land in shared columns whose names differ between
 * iModels, so they are read from the mapping rather than hard coded.
 */
function resolveStorage(db: IModelDb): EsaStorage {
  const classId = db.withPreparedSqliteStatement(
    `SELECT c.Id FROM ec_Class c JOIN ec_Schema s ON s.Id=c.SchemaId
     WHERE c.Name='ExternalSourceAspect' AND s.Name='BisCore'`,
    (stmt) => (stmt.step() === DbResult.BE_SQLITE_ROW ? stmt.getValueInteger(0) : undefined),
  );
  if (classId === undefined)
    throw new Error("This iModel has no BisCore.ExternalSourceAspect class.");

  const column = (accessString: string): { table: string; column: string } => {
    const found = db.withSqliteStatement(
      `SELECT t.Name, col.Name FROM ec_PropertyMap pm
       JOIN ec_PropertyPath pp ON pp.Id=pm.PropertyPathId
       JOIN ec_Column col ON col.Id=pm.ColumnId
       JOIN ec_Table t ON t.Id=col.TableId
       WHERE pm.ClassId=? AND pp.AccessString=?`,
      (stmt) => {
        stmt.bindInteger(1, classId);
        stmt.bindString(2, accessString);
        return stmt.step() === DbResult.BE_SQLITE_ROW
          ? { table: stmt.getValueString(0), column: stmt.getValueString(1) }
          : undefined;
      },
    );
    if (!found)
      throw new Error(`ExternalSourceAspect.${accessString} is not mapped to a column in this iModel.`);
    return found;
  };

  const scope = column("Scope.Id");
  const identifier = column("Identifier");
  const kind = column("Kind");
  const jsonProperties = column("JsonProperties");
  const tables = [scope, identifier, kind, jsonProperties].map((c) => c.table);
  if (new Set(tables).size !== 1)
    throw new Error(
      `ExternalSourceAspect's identity properties are split across tables (${tables.join(", ")}), which this command does not handle.`,
    );

  return {
    classId,
    table: scope.table,
    scope: scope.column,
    identifier: identifier.column,
    kind: kind.column,
    jsonProperties: jsonProperties.column,
  };
}

/** Total ExternalSourceAspects, which the grouping query does not report. */
function countAspects(db: IModelDb, storage: EsaStorage): number {
  return db.withPreparedSqliteStatement(
    `SELECT COUNT(*) FROM ${storage.table} WHERE ECClassId=${storage.classId}`,
    (stmt) => {
      stmt.step();
      return stmt.getValueInteger(0);
    },
  );
}

/**
 * Find every identity that holds more than one aspect, and which aspect to keep.
 *
 * The grouping is left to SQLite. `MIN(Id)` picks the survivor in the same pass, so one query
 * yields both the identity and the aspect to keep -- there is nothing to track in JavaScript,
 * and only one row per duplicate identity crosses into it rather than one per aspect.
 *
 * `MIN` is for a deterministic answer, not a meaningful one: an aspect's id carries a
 * briefcase prefix, so a lower id does not mean an older aspect. Any member of the group
 * would do.
 *
 * SQLite sorts into a temp b-tree to do this. The BisCore index on (Scope, Identifier, Kind)
 * does not avoid it -- measured on a 31M aspect iModel, hinting the index made it slower --
 * because Element.Id and JsonProperties still have to be sorted within each of its runs.
 */
function findDuplicateGroups(
  db: IModelDb,
  storage: EsaStorage,
): { groups: DuplicateGroup[]; scanned: number; redundant: number; largest: number } {
  const groups: DuplicateGroup[] = [];
  let redundant = 0;
  let largest = 0;

  // JsonProperties is compared as the stored text: two aspects whose JSON differs only in key
  // order or spacing group separately, which errs towards keeping both.
  const sql =
    `SELECT ElementId, ${storage.scope}, ${storage.identifier}, ${storage.kind}, ${storage.jsonProperties},
            COUNT(*) AS duplicates, MIN(Id) AS keeper
     FROM ${storage.table}
     WHERE ECClassId=${storage.classId}
     GROUP BY ElementId, ${storage.scope}, ${storage.identifier}, ${storage.kind}, ${storage.jsonProperties}
     HAVING duplicates > 1`;

  db.withSqliteStatement(sql, (stmt) => {
    while (stmt.step() === DbResult.BE_SQLITE_ROW) {
      const count = stmt.getValueInteger(5);
      groups.push({
        elementId: stmt.getValueId(0),
        scope: stmt.isValueNull(1) ? undefined : stmt.getValueId(1),
        identifier: stmt.isValueNull(2) ? undefined : stmt.getValueString(2),
        kind: stmt.isValueNull(3) ? undefined : stmt.getValueString(3),
        jsonProperties: stmt.isValueNull(4) ? undefined : stmt.getValueString(4),
        keeperId: stmt.getValueId(6),
        count,
      });
      redundant += count - 1;
      if (count > largest)
        largest = count;
    }
  });

  return { groups, scanned: countAspects(db, storage), redundant, largest };
}

/**
 * Delete every aspect of one identity except the one being kept.
 *
 * `IS` rather than `=` so a null Scope matches a null Scope; `=` would never match and the
 * duplicates would silently survive.
 */
function deleteGroup(db: IModelDb, storage: EsaStorage, group: DuplicateGroup): number {
  const sql =
    `DELETE FROM ${storage.table}
     WHERE ECClassId=? AND ElementId=? AND ${storage.scope} IS ? AND ${storage.identifier} IS ?
       AND ${storage.kind} IS ? AND ${storage.jsonProperties} IS ?
       AND Id<>?`;
  return db.withPreparedSqliteStatement(sql, (stmt) => {
    stmt.bindInteger(1, storage.classId);
    stmt.bindId(2, group.elementId);
    if (group.scope === undefined)
      stmt.bindNull(3);
    else
      stmt.bindId(3, group.scope);
    if (group.identifier === undefined)
      stmt.bindNull(4);
    else
      stmt.bindString(4, group.identifier);
    if (group.kind === undefined)
      stmt.bindNull(5);
    else
      stmt.bindString(5, group.kind);
    if (group.jsonProperties === undefined)
      stmt.bindNull(6);
    else
      stmt.bindString(6, group.jsonProperties);
    stmt.bindId(7, group.keeperId);

    const rc = stmt.step();
    if (rc !== DbResult.BE_SQLITE_DONE)
      throw new Error(`Deleting duplicates of aspect ${group.keeperId} failed with ${rc}.`);
    return group.count - 1;
  });
}

/**
 * Delete duplicate ExternalSourceAspects, leaving one per identity.
 *
 * The scan completes before the first delete: mutating a table while a reader is still
 * scanning it is unsafe.
 */
export async function runCleanEsa(args: CleanEsaArgs): Promise<CleanEsaResult> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);

  await startIModelHost();
  const db = await BriefcaseDb.open({ fileName: args.imodelPath, readonly: args.dryRun === true });

  try {
    const storage = resolveStorage(db);

    const { groups, scanned, redundant, largest } = findDuplicateGroups(db, storage);
    const result: CleanEsaResult = {
      scanned,
      duplicateGroups: groups.length,
      redundant,
      deleted: 0,
      largestGroup: largest,
    };

    console.log(
      `Scanned ${scanned} ExternalSourceAspect(s); found ${groups.length} duplicate identity group(s) holding ${redundant} redundant aspect(s).`,
    );
    if (groups.length === 0) {
      console.log("No duplicate ExternalSourceAspects to remove.");
      return result;
    }
    console.log(`Largest group holds ${largest} aspects of one identity.`);

    if (args.dryRun) {
      console.log("Dry run: nothing was deleted.");
      return result;
    }

    // Lock the entire iModel before editing
    await db.acquireSchemaLock();

    const editTxn = new EditTxn(db, "clean esa");
    editTxn.start();
    try {
      for (let start = 0; start < groups.length; start += BATCH_SIZE) {
        for (const group of groups.slice(start, start + BATCH_SIZE))
          result.deleted += deleteGroup(db, storage, group);

        editTxn.saveChanges(`clean esa: deleted ${result.deleted} duplicate aspect(s)`);
        if (result.deleted < redundant)
          console.log(`Deleted ${result.deleted} of ${redundant} duplicate aspect(s)...`);
        await new Promise((resolve) => setImmediate(resolve));
      }
      editTxn.end("save", "clean esa complete");
    } catch (err) {
      if (editTxn.isActive)
        editTxn.end("abandon");
      throw err;
    }

    // The aspects were removed underneath the element cache, which does not know about it.
    db.clearCaches();
    console.log(`Deleted ${result.deleted} duplicate aspect(s), leaving one per identity.`);
    return result;
  } finally {
    db.close({ optimize: true });
  }
}

export const cleanEsaCommand: CommandModule<unknown, CleanEsaArgs> = {
  command: "esa",
  describe: "Delete duplicate ExternalSourceAspects, keeping one per Element, Scope, Kind, Identifier and JsonProperties",
  builder: (y) =>
    y
      .option("imodel-path", {
        type: "string",
        demandOption: true,
        describe: "Path to the local iModel file",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "Report the duplicate aspects that would be deleted, without changing the iModel",
      }) as never,
  handler: async (argv) => {
    const result = await runCleanEsa({ imodelPath: argv.imodelPath, dryRun: argv.dryRun });
    if (result.deleted > 0)
      console.log("Local changes saved.");
  },
};
