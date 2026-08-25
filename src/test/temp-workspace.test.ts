import { afterEach, describe, expect, it } from "vitest";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HubMockFixture } from "./hub-mock-fixture";
import { testCacheDir, testTempDir } from "./temp-workspace";

const realCacheDir = join(homedir(), ".imod", "cache");
/** Read before any test moves the environment variable, so it can always be put back. */
const cacheDir = testCacheDir();

afterEach(() => {
  process.env.IMOD_CACHE_DIR = cacheDir;
});

describe("the test workspace", () => {
  it("puts this process's cache under the temp directory", () => {
    expect(realpathSync(testCacheDir()).startsWith(realpathSync(tmpdir()))).toBe(true);
  });

  it("is not the developer's real cache", () => {
    expect(testCacheDir()).not.toBe(realCacheDir);
  });

  it("makes a test's own directories under the same root, so one teardown clears them", () => {
    const dir = testTempDir("example");
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(process.env.IMOD_TEST_ROOT!)).toBe(true);
  });

  /**
   * The guard is what stops a new test file from quietly running against `~/.imod/cache` and
   * locking out every other process using it.
   */
  it("refuses to start a host against the real cache", async () => {
    process.env.IMOD_CACHE_DIR = realCacheDir;
    await expect(new HubMockFixture().startup("should-not-start")).rejects.toThrow(
      /cache must be a temporary directory/,
    );
  });

  it("refuses to start a host with no cache directory at all", async () => {
    delete process.env.IMOD_CACHE_DIR;
    await expect(new HubMockFixture().startup("should-not-start")).rejects.toThrow(
      /IMOD_CACHE_DIR is not set/,
    );
  });
});
