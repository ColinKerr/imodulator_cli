import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeCacheDb, getCacheDb } from "../../cache/cache-db";

const saved = process.env.IMOD_CACHE_DIR;

afterEach(() => {
  closeCacheDb();
  process.env.IMOD_CACHE_DIR = saved;
});

describe("getCacheDb under test", () => {
  it("opens an isolated cache normally", () => {
    // The setup file already pointed IMOD_CACHE_DIR at a temp directory.
    expect(() => getCacheDb()).not.toThrow();
  });

  it("refuses a cache outside the temp directory", () => {
    // The accident this prevents: a test run with no isolated cache reaches ~/.imod/cache, and
    // any beforeEach that does DELETE FROM empties the developer's real index.
    closeCacheDb();
    process.env.IMOD_CACHE_DIR = path.join(os.homedir(), ".imod", "cache-should-never-open");

    expect(() => getCacheDb()).toThrow(/Refusing to open/);
  });

  it("names the variable and the likely cause, so the fix is obvious", () => {
    closeCacheDb();
    const outside = fs.mkdtempSync(path.join(os.homedir(), ".imod-guard-test-"));
    try {
      process.env.IMOD_CACHE_DIR = outside;
      expect(() => getCacheDb()).toThrow(/IMOD_CACHE_DIR/);
      expect(() => getCacheDb()).toThrow(/temp-workspace/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("resolves symlinks before comparing, so a linked temp dir still passes", () => {
    // macOS /tmp is a symlink to /private/tmp; comparing the unresolved paths would reject
    // every legitimate test cache.
    closeCacheDb();
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "imod-guard-"));
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    try {
      process.env.IMOD_CACHE_DIR = link;
      expect(() => getCacheDb()).not.toThrow();
    } finally {
      closeCacheDb();
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
