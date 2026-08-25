import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRunningServer, readServerRecord, stopServerProcess } from "../../../serve/server-process";

/**
 * Driven through the built CLI, because starting a server means spawning its entry point from
 * `dist`: a test calling `startServerProcess` in process would look for it beside the
 * TypeScript source instead.
 *
 * This file starts no IModelHost of its own -- the workspace profile lock is exclusive per
 * cache directory, so a host held open here would stop the backend from starting at all.
 */
const cli = join(__dirname, "..", "..", "..", "..", "dist", "imod.js");
const built = existsSync(cli);

function imod(...args: string[]): void {
  execFileSync(process.execPath, [cli, ...args], { stdio: "ignore" });
}

afterEach(async () => {
  await stopServerProcess("console");
  await stopServerProcess("backend");
});

describe.runIf(built)("imod serve console", () => {
  it("starts a backend when none is running", async () => {
    expect(await findRunningServer("backend")).toBeUndefined();

    imod("serve", "console", "--port", "0");

    const backend = await findRunningServer("backend");
    expect(backend).toBeDefined();
    // The browser is told where it is, which is the whole point of starting it.
    const console = readServerRecord("console")!;
    const config = await (await fetch(`${console.url}/config.json`)).json();
    expect(config.backendRunning).toBe(true);
    expect(config.backendUrl).toBe(backend!.url);
  });

  it("records that it started the backend, so only that one is its to stop", () => {
    imod("serve", "console", "--port", "0");
    expect(readServerRecord("backend")?.startedBy).toBe("console");
  });

  it("leaves a backend that is already running alone", async () => {
    imod("serve", "backend", "--port", "0");
    const started = readServerRecord("backend")!;

    imod("serve", "console", "--port", "0");

    const backend = await findRunningServer("backend");
    expect(backend?.pid).toBe(started.pid);
    expect(backend?.url).toBe(started.url);
    // Not marked as the console's, so the console will not stop it.
    expect(backend?.startedBy).toBeUndefined();
  });
});

describe.runIf(built)("imod serve console --stop", () => {
  it("stops the backend it started", async () => {
    imod("serve", "console", "--port", "0");
    expect(await findRunningServer("backend")).toBeDefined();

    imod("serve", "console", "--stop");

    expect(await findRunningServer("console")).toBeUndefined();
    expect(await findRunningServer("backend")).toBeUndefined();
  });

  it("leaves a backend the user started themselves running", async () => {
    imod("serve", "backend", "--port", "0");
    const started = readServerRecord("backend")!;
    imod("serve", "console", "--port", "0");

    imod("serve", "console", "--stop");

    expect(await findRunningServer("console")).toBeUndefined();
    expect((await findRunningServer("backend"))?.pid).toBe(started.pid);
  });
});
