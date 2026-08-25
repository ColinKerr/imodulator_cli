import type { CommandModule } from "yargs";
import { DEFAULT_CONSOLE_PORT } from "../../serve/console-server";
import {
  findRunningServer, readServerRecord, startServerProcess, stopServerProcess, type ServerRecord,
} from "../../serve/server-process";

export interface ServeConsoleArgs {
  imodelPath?: string;
  port?: number;
  stop?: boolean;
}

export interface ServeConsoleResult {
  console?: ServerRecord;
  backend?: ServerRecord;
  backendRunning?: boolean;
  /** True when the console had to start the backend rather than finding one. */
  backendStarted?: boolean;
  stopped?: boolean;
  /** True when stopping the console also stopped the backend it had started. */
  backendStopped?: boolean;
}

/**
 * The backend the console will query, starting one if none is running.
 *
 * The console is useless without it -- every query, and the iModel itself, comes from the
 * backend -- so starting it is part of starting the console. A backend that was already
 * running is left alone, including the port and the iModel it was started with.
 *
 * A backend that will not start is reported rather than thrown: the console still serves, and
 * the page says there is no backend, which is a better failure than no console at all.
 */
async function ensureBackend(imodelPath?: string): Promise<{ record?: ServerRecord; started: boolean }> {
  const running = await findRunningServer("backend");
  if (running)
    return { record: running, started: false };

  try {
    const record = await startServerProcess("backend", {
      env: { IMOD_SERVE_IMODEL_PATH: imodelPath },
      startedBy: "console",
    });
    return { record, started: true };
  } catch (err) {
    console.warn(`Warning: could not start a backend server: ${err instanceof Error ? err.message : String(err)}`);
    return { started: false };
  }
}

/**
 * Start the query console in its own process and return, leaving it running.
 *
 * The console only serves the web application; everything else comes from `imod serve
 * backend`, which this starts if it is not already running.
 */
export async function runServeConsole(args: ServeConsoleArgs): Promise<ServeConsoleResult> {
  if (args.stop) {
    const result = await stopServerProcess("console");
    if (result.stopped)
      console.log(`Stopped the console at ${result.record?.url} (pid ${result.record?.pid}).`);
    else if (result.staleRecord)
      console.log("The console was not running; cleared a stale record.");
    else
      console.log("The console is not running.");

    // Only the backend this command started: one the user started themselves is theirs to stop.
    const backend = readServerRecord("backend");
    if (backend?.startedBy !== "console")
      return { stopped: result.stopped };

    const backendResult = await stopServerProcess("backend");
    if (backendResult.stopped)
      console.log(`Stopped the backend server it started at ${backendResult.record?.url} (pid ${backendResult.record?.pid}).`);
    return { stopped: result.stopped, backendStopped: backendResult.stopped };
  }

  const backend = await ensureBackend(args.imodelPath);
  const server = await startServerProcess("console", {
    port: args.port,
    env: { IMOD_SERVE_IMODEL_PATH: args.imodelPath },
  });

  console.log(`Console listening at ${server.url} (pid ${server.pid}).`);
  if (backend.started)
    console.log(`Started a backend server at ${backend.record?.url} (pid ${backend.record?.pid}).`);
  else if (backend.record)
    console.log(`Using the backend already running at ${backend.record.url}.`);
  else
    console.warn("Warning: with no backend the console cannot open iModels or run queries.");
  console.log(`Log:          ${server.logFile}`);
  console.log(`Stop it with: imod serve console --stop`);

  return {
    console: server,
    backend: backend.record,
    backendRunning: backend.record !== undefined,
    backendStarted: backend.started,
  };
}

export const serveConsoleCommand: CommandModule<unknown, ServeConsoleArgs> = {
  command: "console",
  describe: "Start the eyeModel Console, a web app for running ECSql queries against a served iModel",
  builder: (y) =>
    y
      .option("imodel-path", {
        type: "string",
        describe: "Path to an iModel to open in the console when it loads",
      })
      .option("port", {
        type: "number",
        default: DEFAULT_CONSOLE_PORT,
        describe: "Port to listen on. 0 picks any free port",
      })
      .option("stop", {
        type: "boolean",
        default: false,
        describe: "Stop the running console, and the backend if the console started it",
      }) as never,
  handler: async (argv) => {
    await runServeConsole({ imodelPath: argv.imodelPath, port: argv.port, stop: argv.stop });
  },
};
