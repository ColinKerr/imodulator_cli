import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BriefcaseDb } from "@itwin/core-backend";
import { startIModelHost } from "../../host/imodel-host";
import { noopAuthClient } from "../../auth/noop-auth-client";
import { AuthorizationClient } from "@itwin/core-common";

export interface VacuumArgs {
  imodelPath: string;
}

export interface VacuumResult {
  /** Size of the iModel file in bytes before vacuuming. */
  bytesBefore: number;
  /** Size of the iModel file in bytes after vacuuming. */
  bytesAfter: number;
  elapsedMs: number;
}

/**
 * Opens the iModel read/write then closes it with the optimize flag so vacuum and analyze is called.
 */
export async function runVacuum(args: VacuumArgs, authClient: AuthorizationClient | undefined = undefined): Promise<VacuumResult> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);

  await startIModelHost(authClient);
  
  const db = await BriefcaseDb.open({ fileName: args.imodelPath, readonly: false });

  const bytesBefore = fs.statSync(args.imodelPath).size;
  const startedAt = Date.now();
  let closed = false;
  try {
    db.close({ optimize: true });
    closed = true;
  } finally {
    if (!closed && db.isOpen)
      db.close();
  }

  return {
    bytesBefore,
    bytesAfter: fs.statSync(args.imodelPath).size,
    elapsedMs: Date.now() - startedAt,
  };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rendered = unit === 0 ? `${value}` : value.toFixed(2);
  return `${bytes < 0 ? "-" : ""}${rendered} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export const vacuumCommand: CommandModule<unknown, VacuumArgs> = {
  command: "vacuum",
  describe: "Vacuum and analyze a local iModel to defragment it and refresh query statistics",
  builder: (y) =>
    y.option("imodel-path", {
      type: "string",
      demandOption: true,
      describe: "Path to the local iModel file",
    }) as never,
  handler: async (argv) => {
    console.log(
      `Vacuuming ${argv.imodelPath}. This rewrites the whole file, so it can take several minutes and needs free disk space of roughly twice the file size.`,
    );
    const result = await runVacuum({ imodelPath: argv.imodelPath }, noopAuthClient);
    const reclaimed = result.bytesBefore - result.bytesAfter;
    console.log(
      `Vacuumed in ${formatDuration(result.elapsedMs)}: ${formatBytes(result.bytesBefore)} -> ${formatBytes(result.bytesAfter)} (${reclaimed >= 0 ? "reclaimed" : "grew by"} ${formatBytes(Math.abs(reclaimed))})`,
    );
  },
};
