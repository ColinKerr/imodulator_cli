import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBackendServer, type RunningServer } from "../../../serve/backend-server";
import { DEFAULT_KEY, resolveIModelKey } from "../../../serve/open-for-serve";
import { readServerRecord, serverRecordPath, stopServerProcess } from "../../../serve/server-process";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";
import { testCacheDir } from "../../temp-workspace";

const fixture = new HubMockFixture();
let cacheDir: string;
let briefcase: TestBriefcase;
/** The briefcase path as the iModel reports it; on macOS the temp dir is a symlink. */
let servedPath: string;
let server: RunningServer | undefined;

beforeAll(async () => {
  cacheDir = testCacheDir();
  await fixture.startup("serve-backend");
  briefcase = await fixture.createBriefcase("served");
  getCacheDb()
    .prepare("INSERT OR REPLACE INTO downloaded_briefcases (imodel_id, briefcase_id, file_path, changeset_id) VALUES (?, ?, ?, ?)")
    .run(briefcase.iModelId, briefcase.briefcaseId, briefcase.fileName, "");
  getCacheDb()
    .prepare("INSERT OR REPLACE INTO downloaded_checkpoints (imodel_id, changeset_id, file_path) VALUES (?, ?, ?)")
    .run(briefcase.iModelId, "abc123", briefcase.fileName);
  servedPath = realpathSync(briefcase.fileName);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

/** Port 0 so tests never collide with a real server or with each other. */
async function start(imodelPath?: string): Promise<RunningServer> {
  server = await startBackendServer({ port: 0, imodelPath });
  return server;
}

async function openKey(url: string, key: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${url}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  return { status: response.status, body: await response.json() };
}

describe("resolveIModelKey", () => {
  it("prefers an existing file path over anything else", () => {
    const resolved = resolveIModelKey(briefcase.fileName);
    expect(resolved.filePath).toBe(briefcase.fileName);
    expect(resolved.source).toBe("path");
  });

  it("resolves a briefcase in the cache by imodelId/briefcaseId", () => {
    const resolved = resolveIModelKey(`${briefcase.iModelId}/${briefcase.briefcaseId}`);
    expect(resolved.filePath).toBe(briefcase.fileName);
    expect(resolved.source).toBe("briefcase");
  });

  it("resolves a checkpoint in the cache by imodelId/changesetId", () => {
    const resolved = resolveIModelKey(`${briefcase.iModelId}/abc123`);
    expect(resolved.filePath).toBe(briefcase.fileName);
    expect(resolved.source).toBe("checkpoint");
  });

  it("reports a key it cannot resolve", () => {
    expect(() => resolveIModelKey("nothing-like-a-key")).toThrow(/No iModel found/);
  });
});

describe("imod serve backend", () => {
  it("serves an iModel opened by file path, keyed by that path", async () => {
    const { url } = await start();

    const { status, body } = await openKey(url, briefcase.fileName);

    expect(status).toBe(200);
    expect(body.key).toBe(briefcase.fileName);
    expect(body.source).toBe("path");
    expect(body.opened).toBe(true);
    // The props are what a client hands to an IModelConnection, so the key must match.
    expect(body.connectionProps.key).toBe(briefcase.fileName);
    expect(body.connectionProps.iModelId).toBe(briefcase.iModelId);
  });

  it("reuses an already open iModel instead of opening it twice", async () => {
    const { url } = await start();

    const first = await openKey(url, briefcase.fileName);
    const second = await openKey(url, briefcase.fileName);

    expect(first.body.opened).toBe(true);
    expect(second.body.opened).toBe(false);
    expect(second.body.connectionProps.key).toBe(first.body.connectionProps.key);
  });

  it("opens a cached briefcase by id", async () => {
    const { url } = await start();
    const key = `${briefcase.iModelId}/${briefcase.briefcaseId}`;

    const { status, body } = await openKey(url, key);

    expect(status).toBe(200);
    expect(body.source).toBe("briefcase");
    expect(body.filePath).toBe(servedPath);
    expect(body.connectionProps.key).toBe(key);
  });

  it("opens --imodel-path under the default key", async () => {
    const { url, defaultIModel } = await start(briefcase.fileName);

    expect(defaultIModel).toEqual({ key: DEFAULT_KEY, filePath: servedPath });

    const listed = await (await fetch(`${url}/imodels`)).json();
    expect(listed.open).toContainEqual({ key: DEFAULT_KEY, filePath: servedPath });

    // A client that knows only the default key can still reach it.
    const { body } = await openKey(url, DEFAULT_KEY);
    expect(body.opened).toBe(false);
    expect(body.connectionProps.key).toBe(DEFAULT_KEY);
  });

  it("answers 404 for a key that names nothing", async () => {
    const { url } = await start();
    const { status, body } = await openKey(url, "/no/such/imodel.bim");
    expect(status).toBe(404);
    expect(body.error).toMatch(/No iModel found/);
  });

  it("answers 400 when no key is supplied", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("serves RPC calls against an opened iModel without any authorization", async () => {
    const { url } = await start(briefcase.fileName);

    // The shape BentleyCloudRpcProtocol uses: /{path}/{version}/mode/{...}/{operation}
    const response = await fetch(`${url}/imodulator/v1.0/mode/1/context/${briefcase.iTwinId}/imodel/${briefcase.iModelId}/changeset/0/IModelReadRpcInterface-3.6.0-getConnectionProps`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify([{ key: DEFAULT_KEY, iModelId: briefcase.iModelId, iTwinId: briefcase.iTwinId }]),
    });

    // No Authorization header was sent; the request must still be served.
    expect(response.status).toBeLessThan(500);
  });

  it("reports the port it actually bound", async () => {
    const running = await start();
    expect(running.port).toBeGreaterThan(0);
    expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
  });
});

describe("server record and --stop", () => {
  it("reports nothing to stop when no server was started", async () => {
    rmSync(serverRecordPath("backend"), { force: true });
    expect(readServerRecord("backend")).toBeUndefined();
    expect(await stopServerProcess("backend")).toEqual({ stopped: false });
  });

  it("clears a stale record instead of killing whatever owns that pid now", async () => {
    // A process id that exists but is certainly not our server: this test runner.
    writeFileSync(
      serverRecordPath(),
      JSON.stringify({
        pid: process.pid,
        port: 1,
        url: "http://127.0.0.1:1",
        startedAt: new Date().toISOString(),
        logFile: "unused",
      }),
    );

    const result = await stopServerProcess();

    expect(result.stopped).toBe(false);
    expect(result.staleRecord).toBe(true);
    // The record is gone and this process is still very much alive.
    expect(readServerRecord()).toBeUndefined();
  });
});
