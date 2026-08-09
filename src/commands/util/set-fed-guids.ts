import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BriefcaseDb, type IModelDb } from "@itwin/core-backend";
import { DbResult, Guid, type Id64String } from "@itwin/core-bentley";
import { startIModelHost } from "../../host/imodel-host";
import { noopAuthClient } from "../../auth/noop-auth-client";

/** Elements assigned per transaction. */
export const BATCH_SIZE = 50_000;

/** Attempts to find a free GUID for one element before giving up on it. */
const MAX_GUID_ATTEMPTS = 3;

export interface SetFedGuidsArgs {
  imodelPath: string;
  /** Report what would be assigned without writing anything. */
  dryRun?: boolean;
}

export interface SetFedGuidsResult {
  /** Elements without a FederationGuid when the command started. */
  unsetBefore: number;
  updated: number;
  /** Elements the update could not assign, left unset. */
  failed: number;
  /** Elements still without a FederationGuid when the command finished. */
  unsetAfter: number;
}

/**
 * The 16 bytes a FederationGuid is stored as.
 *
 * The blob is the GUID in canonical RFC 4122 order -- the dashless string decoded left to
 * right -- *not* the mixed-endian layout that byte-swaps the first three groups. Verified
 * against stored data: the blob `000002A63C684A0D98763F36358CA43B` is read back by the
 * element API as `000002a6-3c68-4a0d-9876-3f36358ca43b`.
 */
export function guidToBlob(guid: string): Uint8Array {
  const hex = guid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex))
    throw new Error(`Not a GUID: ${guid}`);
  return Buffer.from(hex, "hex");
}

export async function runSetFedGuids(args: SetFedGuidsArgs): Promise<SetFedGuidsResult> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);

  await startIModelHost(noopAuthClient);
  const db = await BriefcaseDb.open({ fileName: args.imodelPath, readonly: false });

  try {
    const unsetBefore = countUnset(db);
    console.log(`Found ${unsetBefore} element(s) with no FederationGuid.`);

    if (args.dryRun || unsetBefore === 0) {
      if (args.dryRun)
        console.log("Dry run: nothing was written.");
      return { unsetBefore, updated: 0, failed: 0, unsetAfter: unsetBefore };
    }

    // Lock the entire iModel before editing
    await db.acquireSchemaLock();

    let updated = 0;
    let failed = 0;
    for (;;) {
      const ids = nextUnsetBatch(db);
      if (ids.length === 0)
        break;

      const assigned = assignGuids(db, ids);
      updated += assigned;
      failed += ids.length - assigned;

      // Every element in the batch was rejected, so the next query would return the same
      // ids forever. Stop rather than spin.
      if (assigned === 0) {
        console.warn(`Giving up: none of the ${ids.length} element(s) in this batch could be assigned a FederationGuid.`);
        break;
      }

      db.saveChanges(`set-fed-guids: assigned ${updated} FederationGuid(s)`);
      console.log(`Assigned ${updated} of ${unsetBefore} FederationGuid(s)...`);
    }

    // The element cache does not know about writes made straight through SQLite.
    db.clearCaches();

    const unsetAfter = countUnset(db);
    console.log(
      `Assigned ${updated} FederationGuid(s); ${unsetAfter} element(s) still unset${failed > 0 ? ` (${failed} could not be assigned)` : ""}.`,
    );
    return { unsetBefore, updated, failed, unsetAfter };
  } finally {
    db.close();
  }
}

function countUnset(db: IModelDb): number {
  return db.withSqliteStatement(
    "SELECT COUNT(*) FROM bis_Element WHERE FederationGuid IS NULL",
    (stmt) => {
      if (stmt.step() !== DbResult.BE_SQLITE_ROW)
        throw new Error("Could not count elements without a FederationGuid.");
      return stmt.getValueInteger(0);
    },
  );
}

/**
 * The next elements to assign. Because assigning a GUID takes an element out of this
 * query, paging keeps memory bounded no matter how many elements are unset.
 */
function nextUnsetBatch(db: IModelDb): Id64String[] {
  return db.withPreparedSqliteStatement(
    `SELECT Id FROM bis_Element WHERE FederationGuid IS NULL LIMIT ${BATCH_SIZE}`,
    (stmt) => {
      const ids: Id64String[] = [];
      while (stmt.step() === DbResult.BE_SQLITE_ROW)
        ids.push(stmt.getValueId(0));
      return ids;
    },
  );
}

/**
 * Assign a GUID to each element, returning how many were written.
 *
 * The update goes straight through SQLite rather than the element API: FederationGuid is a
 * plain identifier with no dependent state, and raw writes on this connection are still
 * captured as local txns, so the result is a pushable changeset. This is a deliberate
 * choice for the sake of doing hundreds of thousands of rows in one pass.
 */
function assignGuids(db: IModelDb, ids: Id64String[]): number {
  let assigned = 0;
  db.withSqliteStatement("UPDATE bis_Element SET FederationGuid=? WHERE Id=?", (stmt) => {
    for (const id of ids) {
      // FederationGuid is UNIQUE, so a collision is possible in principle. It should never
      // happen with random GUIDs, but one bad row must not end the run.
      for (let attempt = 1; ; attempt++) {
        stmt.reset();
        stmt.clearBindings();
        stmt.bindBlob(1, guidToBlob(Guid.createValue()));
        stmt.bindId(2, id);

        let result: DbResult;
        try {
          result = stmt.step();
        } catch {
          result = DbResult.BE_SQLITE_ERROR;
        }

        if (result === DbResult.BE_SQLITE_DONE) {
          assigned++;
          break;
        }
        if (attempt >= MAX_GUID_ATTEMPTS) {
          console.warn(`Could not assign a FederationGuid to element ${id}.`);
          break;
        }
      }
    }
  });
  return assigned;
}

export const setFedGuidsCommand: CommandModule<unknown, SetFedGuidsArgs> = {
  command: "set-fed-guids",
  describe: "Assign a FederationGuid to every element in the iModel that does not have one",
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
        describe: "Report how many elements would be assigned a FederationGuid, without writing",
      }) as never,
  handler: async (argv) => {
    const result = await runSetFedGuids({ imodelPath: argv.imodelPath, dryRun: argv.dryRun });
    if (!argv.dryRun && result.updated > 0)
      console.log("Local changes saved. Push them with: imod hub briefcase push");
  },
};
