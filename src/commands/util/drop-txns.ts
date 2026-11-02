import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BriefcaseDb } from "@itwin/core-backend";
import { AuthorizationClient } from "@itwin/core-common";
import { startIModelHost } from "../../host/imodel-host";
import { noopAuthClient } from "../../auth/noop-auth-client";
import { formatBytes, formatDuration } from "./vacuum";

export interface DropTxnsArgs {
  imodelPath: string;
  /** Revert the local changes and release all locks instead of keeping the changes in the file. */
  discardChanges?: boolean;
}

export interface DropTxnsResult {
  hadUnsavedChanges: boolean;
  hadPendingTxns: boolean;
  /** True when the local changes were reverted, false when they were kept in the file. */
  discardedChanges: boolean;
  /** Size of the iModel file in bytes before vacuuming. */
  bytesBefore: number;
  /** Size of the iModel file in bytes after vacuuming. */
  bytesAfter: number;
  /** Time spent vacuuming. */
  vacuumMs: number;
}

/**
 * Removes every txn from the iModel so it has no local changes left to push.
 * By default the changes stay in the file and only the txn records are deleted.  With
 * `discardChanges` the briefcase is reverted to its last synchronized state and its locks released.
 * The iModel is then closed with the optimize flag so vacuum and analyze is called.
 */
export async function runDropTxns(args: DropTxnsArgs, authClient: AuthorizationClient | undefined = undefined): Promise<DropTxnsResult> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);

  await startIModelHost(authClient);

  const db = await BriefcaseDb.open({ fileName: args.imodelPath, readonly: false });
  let closed = false;
  try {
    const hadUnsavedChanges = db.txns.hasUnsavedChanges;
    const hadPendingTxns = db.txns.hasPendingTxns;
    const discardedChanges = args.discardChanges ?? false;

    if (discardedChanges)
      await db.discardChanges();
    else
      db.txns.deleteAllTxns();

    if (db.txns.hasLocalChanges)
      throw new Error(`iModel still has local changes after dropping txns: ${args.imodelPath}`);

    if (!hadPendingTxns && !hadUnsavedChanges)
      console.log(`No txns to drop in ${args.imodelPath}`);
    else
      console.log(discardedChanges
        ? `Discarded local changes and released locks in ${args.imodelPath}`
        : `Dropped txns in ${args.imodelPath}. The changes remain in the file`);

    console.log(
      `Vacuuming ${args.imodelPath}. This rewrites the whole file, so it can take several minutes and needs free disk space of roughly twice the file size.`,
    );
    const bytesBefore = fs.statSync(args.imodelPath).size;
    const startedAt = Date.now();
    db.close({ optimize: true });
    closed = true;

    return {
      hadUnsavedChanges,
      hadPendingTxns,
      discardedChanges,
      bytesBefore,
      bytesAfter: fs.statSync(args.imodelPath).size,
      vacuumMs: Date.now() - startedAt,
    };
  } finally {
    if (!closed && db.isOpen)
      db.close();
  }
}

export const dropTxnsCommand: CommandModule<unknown, DropTxnsArgs> = {
  command: "drop-txns",
  describe: "Drop all local txns from an iModel. By default the changes stay in the file but without the txns no changesets can be created from them",
  builder: (y) =>
    y
      .option("imodel-path", {
        type: "string",
        demandOption: true,
        describe: "Path to the local iModel file",
      })
      .option("discard-changes", {
        type: "boolean",
        default: false,
        describe: "Revert the local changes and release all locks instead of keeping the changes in the file",
      }) as never,
  handler: async (argv) => {
    // Releasing locks talks to the hub, so discarding needs a signed in user.
    const authClient = argv.discardChanges ? undefined : noopAuthClient;
    const result = await runDropTxns({ imodelPath: argv.imodelPath, discardChanges: argv.discardChanges }, authClient);
    const reclaimed = result.bytesBefore - result.bytesAfter;
    console.log(
      `Vacuumed in ${formatDuration(result.vacuumMs)}: ${formatBytes(result.bytesBefore)} -> ${formatBytes(result.bytesAfter)} (${reclaimed >= 0 ? "reclaimed" : "grew by"} ${formatBytes(Math.abs(reclaimed))})`,
    );
  },
};
