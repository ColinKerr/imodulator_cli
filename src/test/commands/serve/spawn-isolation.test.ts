import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServerRecord, stopServerProcess } from "../../../serve/server-process";
import { testCacheDir } from "../../temp-workspace";

/**
 * A spawned server resolves its own cache directory, in its own process. If it does not
 * inherit this run's, it opens the developer's real cache and takes the workspace profile
 * lock away from everything else using it -- which is what a leaked test server used to do.
 *
 * This file deliberately starts no IModelHost of its own: the profile lock is exclusive per
 * cache directory, so a test that held the host open could not let the server start at all.
 */

const cli = join(__dirname, "..", "..", "..", "..", "dist", "imod.js");

afterEach(async () => {
  await stopServerProcess("backend");
});

describe("a server spawned by the CLI", () => {
  it("works in the same cache directory as the run that started it", async () => {
    if (!existsSync(cli))
      throw new Error(`${cli} is missing: run "npm run build" before the tests.`);

    // The real CLI, because that is the path that leaks: `imod serve` detaches the server
    // and returns, leaving a process that outlives the run.
    execFileSync(process.execPath, [cli, "serve", "backend", "--port", "0"], { stdio: "ignore" });

    const record = readServerRecord("backend");
    expect(record).toBeDefined();

    const health = (await (await fetch(`${record!.url}/health`)).json()) as { cacheDir: string };
    expect(realpathSync(health.cacheDir)).toBe(realpathSync(testCacheDir()));
    expect(realpathSync(health.cacheDir).startsWith(realpathSync(tmpdir()))).toBe(true);
  });

  it("is stopped by teardown rather than left running", async () => {
    if (!existsSync(cli))
      throw new Error(`${cli} is missing: run "npm run build" before the tests.`);
    execFileSync(process.execPath, [cli, "serve", "backend", "--port", "0"], { stdio: "ignore" });

    const record = readServerRecord("backend")!;
    // What the shared teardown does at the end of every test process.
    const result = await stopServerProcess("backend");

    expect(result.stopped).toBe(true);
    expect(await fetch(`${record.url}/health`).then(() => true, () => false)).toBe(false);
  });
});
