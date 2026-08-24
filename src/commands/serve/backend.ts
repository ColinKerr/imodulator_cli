import type { CommandModule } from "yargs";
import { DEFAULT_PORT } from "../../serve/backend-server";
import { startServerProcess, stopServerProcess, type ServerRecord } from "../../serve/server-process";

export interface ServeBackendArgs {
  imodelPath?: string;
  port?: number;
  stop?: boolean;
}

export interface ServeBackendResult {
  /** Undefined when `--stop` was used. */
  server?: ServerRecord;
  stopped?: boolean;
}

/**
 * Start an iTwin.js RPC backend in its own process and return, leaving it running so other
 * commands can be used while it serves.
 */
export async function runServeBackend(args: ServeBackendArgs): Promise<ServeBackendResult> {
  if (args.stop) {
    const result = await stopServerProcess("backend");
    if (result.stopped)
      console.log(`Stopped the backend server at ${result.record?.url} (pid ${result.record?.pid}).`);
    else if (result.staleRecord)
      console.log("No backend server was running; cleared a stale record.");
    else
      console.log("No backend server is running.");
    return { stopped: result.stopped };
  }

  const server = await startServerProcess("backend", {
    port: args.port,
    env: { IMOD_SERVE_IMODEL_PATH: args.imodelPath },
  });

  console.log(`Backend server listening at ${server.url} (pid ${server.pid}).`);
  if (server.defaultIModel)
    console.log(`Opened ${server.defaultIModel.filePath} with key "${server.defaultIModel.key}".`);
  console.log(`Open an iModel:  curl -X POST ${server.url}/open -H "Content-Type: application/json" -d '{"key":"<path or imodelId/briefcaseId>"}'`);
  console.log(`Log:             ${server.logFile}`);
  console.log(`Stop it with:    imod serve backend --stop`);

  return { server };
}

export const serveBackendCommand: CommandModule<unknown, ServeBackendArgs> = {
  command: "backend",
  describe: "Start a local iTwin.js RPC backend that serves iModels from the cache or from a file path",
  builder: (y) =>
    y
      .option("imodel-path", {
        type: "string",
        describe: 'Path to an iModel to open at startup, reachable under the key "default"',
      })
      .option("port", {
        type: "number",
        default: DEFAULT_PORT,
        describe: "Port to listen on. 0 picks any free port",
      })
      .option("stop", {
        type: "boolean",
        default: false,
        describe: "Stop the running backend server",
      }) as never,
  handler: async (argv) => {
    await runServeBackend({ imodelPath: argv.imodelPath, port: argv.port, stop: argv.stop });
  },
};
