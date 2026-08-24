import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runServeStopAll } from "../../../commands/serve/stop-all";
import { readServerRecord, serverRecordPath, SERVER_KINDS, type ServerKind } from "../../../serve/server-process";

let cacheDir: string;
let children: ChildProcess[] = [];

beforeAll(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "imod-stop-all-cache-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
});

afterEach(() => {
  for (const child of children)
    child.kill("SIGKILL");
  children = [];
  for (const kind of SERVER_KINDS)
    rmSync(serverRecordPath(kind), { force: true });
});

afterAll(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function writeRecord(kind: ServerKind, pid: number, port: number): void {
  writeFileSync(
    serverRecordPath(kind),
    JSON.stringify({ kind, pid, port, url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString(), logFile: "unused" }),
  );
}

/**
 * A stand-in server: answers /health as the given kind and dies on SIGTERM, so the real kill
 * path can be exercised against a process this test owns.
 */
async function startFakeServer(kind: ServerKind): Promise<{ pid: number; port: number }> {
  const source = `
    const http = require("node:http");
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ server: ${JSON.stringify(kind)} }));
    });
    server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
  `;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(child);
  const port = await new Promise<number>((resolve) => child.once("message", (m) => resolve((m as { port: number }).port)));
  return { pid: child.pid!, port };
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("imod serve stop-all", () => {
  it("reports every kind as not running when nothing has been started", async () => {
    const result = await runServeStopAll();

    expect(result.stopped).toEqual([]);
    expect(result.staleRecords).toEqual([]);
    // Every server kind is accounted for, which is what makes the command complete.
    expect([...result.notRunning].sort()).toEqual([...SERVER_KINDS].sort());
  });

  it("stops a running server and clears its record", async () => {
    const fake = await startFakeServer("backend");
    writeRecord("backend", fake.pid, fake.port);

    const result = await runServeStopAll();

    expect(result.stopped).toEqual([
      { kind: "backend", url: `http://127.0.0.1:${fake.port}`, pid: fake.pid },
    ]);
    expect(readServerRecord("backend")).toBeUndefined();
    // Give the signal a moment to land before asking.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isRunning(fake.pid)).toBe(false);
  });

  it("stops every running server, not just the first", async () => {
    const backend = await startFakeServer("backend");
    const consoleServer = await startFakeServer("console");
    writeRecord("backend", backend.pid, backend.port);
    writeRecord("console", consoleServer.pid, consoleServer.port);

    const result = await runServeStopAll();

    expect(result.stopped.map((s) => s.kind).sort()).toEqual(["backend", "console"]);
    // The console is stopped first: it queries the backend, so the dependent goes down first.
    expect(result.stopped[0].kind).toBe("console");
    expect(readServerRecord("backend")).toBeUndefined();
    expect(readServerRecord("console")).toBeUndefined();
  });

  it("clears a stale record without killing whatever owns that pid now", async () => {
    // This test process certainly is not our server, and must survive.
    writeRecord("backend", process.pid, 1);

    const result = await runServeStopAll();

    expect(result.staleRecords).toEqual(["backend"]);
    expect(result.stopped).toEqual([]);
    expect(readServerRecord("backend")).toBeUndefined();
    expect(isRunning(process.pid)).toBe(true);
  });

  it("is idempotent: a second run finds nothing left", async () => {
    const fake = await startFakeServer("backend");
    writeRecord("backend", fake.pid, fake.port);

    expect((await runServeStopAll()).stopped).toHaveLength(1);
    const second = await runServeStopAll();
    expect(second.stopped).toEqual([]);
    expect(second.staleRecords).toEqual([]);
  });
});
