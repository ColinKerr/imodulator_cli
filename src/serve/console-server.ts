import type { Server } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import express from "express";
import { findRunningServer, type ServerRecord } from "./server-process";

export const DEFAULT_CONSOLE_PORT = 8080;

export interface ConsoleServerArgs {
  /** 0 asks the OS for any free port, which the result reports back. */
  port?: number;
  /** Opened in the console when it loads, if the backend has it. */
  imodelPath?: string;
  /**
   * Where the frontend build lives. Defaults to `dist/web`; tests point it at a temporary
   * directory so they never write a stand-in page over the real build output.
   */
  webRoot?: string;
}

export interface RunningConsole {
  port: number;
  url: string;
  backend?: ServerRecord;
  close(): Promise<void>;
}

/**
 * Where the frontend build lands.
 *
 * Anchored to the package root rather than to this file, so it resolves the same whether the
 * server is running from `dist/serve` or straight from `src/serve` under the test runner.
 */
function webRoot(): string {
  return path.join(__dirname, "..", "..", "dist", "web");
}

/**
 * The console is only static assets plus a little configuration: every query, and the iModel
 * itself, comes from `imod serve backend` over RPC. The browser talks to that server
 * directly, which is why the backend answers CORS preflights.
 */
export async function startConsoleServer(args: ConsoleServerArgs = {}): Promise<RunningConsole> {
  const root = args.webRoot ?? webRoot();
  if (!fs.existsSync(path.join(root, "index.html")))
    throw new Error(`The console frontend has not been built: ${root} is missing. Run "npm run build".`);

  const app = express();

  /** Identifies this server to `imod serve`. */
  app.get("/health", (_req, res) => {
    res.json({ server: "console" });
  });

  /**
   * Where the backend is, looked up on each request rather than at startup: the backend can
   * be restarted, or started later, without restarting the console.
   */
  app.get("/config.json", async (_req, res) => {
    const backend = await findRunningServer("backend");
    res.json({
      backendUrl: backend?.url,
      backendRunning: backend !== undefined,
      imodelPath: args.imodelPath,
    });
  });

  app.use(express.static(root));

  // Anything else is the single page app.
  app.use(/.*/, (_req, res) => res.sendFile(path.join(root, "index.html")));

  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(args.port ?? DEFAULT_CONSOLE_PORT, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (args.port ?? DEFAULT_CONSOLE_PORT);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    backend: await findRunningServer("backend"),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
