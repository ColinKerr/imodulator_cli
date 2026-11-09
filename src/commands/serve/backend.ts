import type { CommandModule } from "yargs";
import { DEFAULT_PORT } from "../../serve/backend-server";
import { foregroundRequested, holdForeground, startServerProcess, stopServerProcess, type ServerRecord } from "../../serve/server-process";

export interface ServeBackendArgs {
  imodelPath?: string;
  port?: number;
  stop?: boolean;
  /** Also answer as a local sign-in and the iTwin Platform API, from the cache. */
  itwinPlatform?: boolean;
  /** With `itwinPlatform`, the one web app origin allowed to use it. */
  appOrigin?: string;
  /** Stay attached, with the log in this terminal, until Ctrl+C. */
  foreground?: boolean;
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

  const foreground = foregroundRequested(args.foreground);
  const server = await startServerProcess("backend", {
    port: args.port,
    env: {
      IMOD_SERVE_IMODEL_PATH: args.imodelPath,
      IMOD_SERVE_ITWIN_PLATFORM: args.itwinPlatform ? "1" : undefined,
      IMOD_SERVE_APP_ORIGIN: args.appOrigin,
    },
    foreground,
  });

  console.log(`Backend server listening at ${server.url} (pid ${server.pid}).`);
  if (server.defaultIModel)
    console.log(`Opened ${server.defaultIModel.filePath} with key "${server.defaultIModel.key}".`);
  if (server.itwinPlatform) {
    console.log(`Sign-in (IMS):   ${server.itwinPlatform.signInUrl}`);
    console.log(`iTwin API:       ${server.itwinPlatform.apiUrl}`);
  }
  console.log(`Open an iModel:  curl -X POST ${server.url}/open -H "Content-Type: application/json" -d '{"key":"<path or imodelId/briefcaseId>"}'`);
  console.log(`Log:             ${server.logFile}`);
  if (foreground) {
    console.log("Stop it with:    Ctrl+C");
    await holdForeground();
    return { server, stopped: true };
  }
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
      .option("itwin-platform", {
        type: "boolean",
        default: false,
        describe: "Also answer as a local sign-in (no account) and as the iTwin Platform API for the iModels in the cache, so a standard iTwin.js web app can pick and view them. Local use only",
      })
      .option("app-origin", {
        type: "string",
        describe: "With --itwin-platform, the one web app origin allowed to use it, such as http://localhost:3000. Any origin when not given",
      })
      .option("stop", {
        type: "boolean",
        default: false,
        describe: "Stop the running backend server",
      })
      .option("foreground", {
        type: "boolean",
        default: false,
        describe: "Stay attached: print the server logs in this terminal, and stop on Ctrl+C. IMOD_SERVE_FOREGROUND=1 does the same",
      }) as never,
  handler: async (argv) => {
    await runServeBackend({
      imodelPath: argv.imodelPath,
      port: argv.port,
      stop: argv.stop,
      foreground: argv.foreground,
      itwinPlatform: argv.itwinPlatform,
      appOrigin: argv.appOrigin,
    });
  },
};
