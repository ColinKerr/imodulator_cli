import type { CommandModule } from "yargs";
import { DEFAULT_CONSOLE_PORT } from "../../serve/console-server";
import { findRunningServer, startServerProcess, stopServerProcess, type ServerRecord } from "../../serve/server-process";

export interface ServeConsoleArgs {
  imodelPath?: string;
  port?: number;
  stop?: boolean;
}

export interface ServeConsoleResult {
  console?: ServerRecord;
  backendRunning?: boolean;
  stopped?: boolean;
}

/**
 * Start the query console in its own process and return, leaving it running.
 *
 * The console only serves the web application; it queries through `imod serve backend`, so a
 * missing backend is worth warning about here rather than leaving the browser to discover it.
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
    return { stopped: result.stopped };
  }

  const backend = await findRunningServer("backend");
  const server = await startServerProcess("console", {
    port: args.port,
    env: { IMOD_SERVE_IMODEL_PATH: args.imodelPath },
  });

  console.log(`Console listening at ${server.url} (pid ${server.pid}).`);
  if (backend)
    console.log(`Using the backend at ${backend.url}.`);
  else
    console.warn(
      "Warning: no backend server is running, so the console cannot open iModels or run queries.\n" +
        "         Start one with: imod serve backend",
    );
  console.log(`Log:          ${server.logFile}`);
  console.log(`Stop it with: imod serve console --stop`);

  return { console: server, backendRunning: backend !== undefined };
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
        describe: "Stop the running console",
      }) as never,
  handler: async (argv) => {
    await runServeConsole({ imodelPath: argv.imodelPath, port: argv.port, stop: argv.stop });
  },
};
