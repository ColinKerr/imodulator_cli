import type { CommandModule } from "yargs";
import { SERVER_KINDS, serverLabel, stopServerProcess, type ServerKind } from "../../serve/server-process";

export interface StoppedServer {
  kind: ServerKind;
  url: string;
  pid: number;
}

export interface ServeStopAllResult {
  stopped: StoppedServer[];
  /** Servers that had a record but were not running; the record was cleared. */
  staleRecords: ServerKind[];
  notRunning: ServerKind[];
}

/**
 * Stop every running server.
 *
 * Works through {@link SERVER_KINDS}, which is derived from the server definitions, so a
 * server added later is stopped here without anyone remembering to update this command.
 */
export async function runServeStopAll(): Promise<ServeStopAllResult> {
  const result: ServeStopAllResult = { stopped: [], staleRecords: [], notRunning: [] };

  for (const kind of SERVER_KINDS) {
    const outcome = await stopServerProcess(kind);
    if (outcome.stopped && outcome.record)
      result.stopped.push({ kind, url: outcome.record.url, pid: outcome.record.pid });
    else if (outcome.staleRecord)
      result.staleRecords.push(kind);
    else
      result.notRunning.push(kind);
  }

  report(result);
  return result;
}

function report(result: ServeStopAllResult): void {
  if (result.stopped.length === 0 && result.staleRecords.length === 0) {
    console.log("No servers are running.");
    return;
  }

  for (const server of result.stopped)
    console.log(`Stopped the ${serverLabel(server.kind)} at ${server.url} (pid ${server.pid}).`);
  for (const kind of result.staleRecords)
    console.log(`The ${serverLabel(kind)} was not running; cleared a stale record.`);
  for (const kind of result.notRunning)
    console.log(`The ${serverLabel(kind)} was not running.`);
}

export const serveStopAllCommand: CommandModule<unknown, object> = {
  command: "stop-all",
  describe: "Stop all running servers",
  builder: (y) => y,
  handler: async () => {
    await runServeStopAll();
  },
};
