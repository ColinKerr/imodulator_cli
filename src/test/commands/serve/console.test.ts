import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startConsoleServer, type RunningConsole } from "../../../serve/console-server";
import { serverRecordPath } from "../../../serve/server-process";
import { testCacheDir, testTempDir } from "../../temp-workspace";

let cacheDir: string;
let webRoot: string;
let consoleServer: RunningConsole | undefined;

beforeAll(() => {
  cacheDir = testCacheDir();
  // A stand-in for the frontend build. It goes in a temp directory: writing it into the
  // real dist/web would overwrite whatever the last build produced.
  webRoot = testTempDir("console-web");
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>t</title>");
});

afterEach(async () => {
  await consoleServer?.close();
  consoleServer = undefined;
  rmSync(serverRecordPath("backend"), { force: true });
});

async function start(imodelPath?: string): Promise<RunningConsole> {
  consoleServer = await startConsoleServer({ port: 0, imodelPath, webRoot });
  return consoleServer;
}

describe("imod serve console", () => {
  it("fails when the port is already taken, rather than reporting a server that never bound", async () => {
    const running = await start();

    await expect(startConsoleServer({ port: running.port, webRoot })).rejects.toThrow(/EADDRINUSE/);
  });

  it("serves the console application", async () => {
    const { url } = await start();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!doctype html>");
  });

  it("identifies itself so --stop cannot kill the wrong process", async () => {
    const { url } = await start();
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ server: "console" });
  });

  it("reports that no backend is running", async () => {
    const { url, backend } = await start();
    expect(backend).toBeUndefined();
    expect(await (await fetch(`${url}/config.json`)).json()).toEqual({ backendRunning: false });
  });

  it("passes the backend url and the startup iModel to the browser", async () => {
    // A record for a backend that answers /health as a backend would.
    const fake = await startFakeBackend();
    try {
      const { url } = await start("/tmp/some.bim");
      const config = await (await fetch(`${url}/config.json`)).json();
      expect(config).toEqual({
        backendUrl: fake.url,
        backendRunning: true,
        imodelPath: "/tmp/some.bim",
      });
    } finally {
      await fake.close();
    }
  });

  it("does not trust a recorded backend that is not answering", async () => {
    writeFileSync(
      serverRecordPath("backend"),
      JSON.stringify({ kind: "backend", pid: process.pid, port: 1, url: "http://127.0.0.1:1", startedAt: "", logFile: "" }),
    );
    const { url } = await start();
    const config = await (await fetch(`${url}/config.json`)).json();
    expect(config.backendRunning).toBe(false);
  });
});

/** A stand-in for `imod serve backend`: just the health endpoint the console looks for. */
async function startFakeBackend(): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ server: "backend" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(
    serverRecordPath("backend"),
    JSON.stringify({ kind: "backend", pid: process.pid, port, url, startedAt: "", logFile: "" }),
  );
  return { url, close: async () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
