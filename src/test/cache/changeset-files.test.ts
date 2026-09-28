import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BriefcaseManager } from "@itwin/core-backend";
import { closeCacheDb, getCacheDb } from "../../cache/cache-db";
import {
  changesetFileName, changesetKeepDir, keepChangesetFile, restoreChangesetFiles,
} from "../../cache/changeset-files";
import { recordChangesetFile, upsertChangesetMetadata, listCachedChangesets } from "../../cache/changesets";
import { HubMockFixture } from "../hub-mock-fixture";

// BriefcaseManager.getChangeSetsPath needs a started host to know the cache root.
const fixture = new HubMockFixture();
const IMODEL = "11111111-1111-1111-1111-111111111111";

beforeEach(async () => {
  if (!existsSync(join(process.env.IMOD_CACHE_DIR!, "imodels")))
    await fixture.startup("changeset-files");
  getCacheDb().prepare("DELETE FROM changesets").run();
  rmSync(changesetKeepDir(IMODEL), { recursive: true, force: true });
  rmSync(BriefcaseManager.getChangeSetsPath(IMODEL), { recursive: true, force: true });
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

/** A changeset in iTwin.js's own directory, as a download would leave it. */
function downloadedChangeset(changesetId: string, contents = "changeset bytes"): string {
  const dir = BriefcaseManager.getChangeSetsPath(IMODEL);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, changesetFileName(changesetId));
  writeFileSync(filePath, contents);
  return filePath;
}

/** What iTwin.js does to a changeset once it has applied it. */
function iTwinJsDeletesIt(changesetId: string): void {
  rmSync(join(BriefcaseManager.getChangeSetsPath(IMODEL), changesetFileName(changesetId)), { force: true });
}

describe("keeping changeset files", () => {
  it("gives a downloaded changeset a second name, not a second copy", () => {
    const downloaded = downloadedChangeset("cs1");

    const keepPath = keepChangesetFile(IMODEL, "cs1", downloaded);

    expect(existsSync(keepPath)).toBe(true);
    expect(keepPath).not.toBe(downloaded);
    // One inode with two names: no extra disk, and either name reaches the same bytes.
    expect(statSync(keepPath).ino).toBe(statSync(downloaded).ino);
    expect(statSync(keepPath).nlink).toBe(2);
  });

  it("survives iTwin.js deleting the changeset it applied", () => {
    // The whole point. iTwin.js removes each changeset after applying it
    // (BriefcaseManager.ts:494); unlinking its name must not take ours with it.
    const downloaded = downloadedChangeset("cs1", "important bytes");
    const keepPath = keepChangesetFile(IMODEL, "cs1", downloaded);

    iTwinJsDeletesIt("cs1");

    expect(existsSync(downloaded)).toBe(false);
    expect(existsSync(keepPath)).toBe(true);
    expect(statSync(keepPath).size).toBe("important bytes".length);
  });

  it("is idempotent for a changeset already kept", () => {
    const downloaded = downloadedChangeset("cs1");
    const first = keepChangesetFile(IMODEL, "cs1", downloaded);

    const second = keepChangesetFile(IMODEL, "cs1", downloaded);

    expect(second).toBe(first);
    expect(statSync(first).nlink).toBe(2);
  });

  it("replaces a stale keep with the freshly downloaded file", () => {
    // A keep left from an earlier, different file must not shadow a real download.
    mkdirSync(changesetKeepDir(IMODEL), { recursive: true });
    writeFileSync(join(changesetKeepDir(IMODEL), changesetFileName("cs1")), "stale");
    const downloaded = downloadedChangeset("cs1", "fresh bytes");

    const keepPath = keepChangesetFile(IMODEL, "cs1", downloaded);

    expect(statSync(keepPath).ino).toBe(statSync(downloaded).ino);
    expect(statSync(keepPath).size).toBe("fresh bytes".length);
  });
});

describe("restoring what iTwin.js deleted", () => {
  function cacheOneChangeset(changesetId: string, index: number): string {
    upsertChangesetMetadata(IMODEL, [{ index, id: changesetId, fileSize: 15 }]);
    const downloaded = downloadedChangeset(changesetId);
    const keepPath = keepChangesetFile(IMODEL, changesetId, downloaded);
    recordChangesetFile(IMODEL, index, keepPath);
    return keepPath;
  }

  it("puts the name back so a later download skips it instead of fetching it again", () => {
    const keepPath = cacheOneChangeset("cs1", 1);
    iTwinJsDeletesIt("cs1");
    const workPath = join(BriefcaseManager.getChangeSetsPath(IMODEL), changesetFileName("cs1"));
    expect(existsSync(workPath)).toBe(false);

    const restored = restoreChangesetFiles(IMODEL);

    expect(restored).toBe(1);
    expect(existsSync(workPath)).toBe(true);
    // Linked from the kept file rather than downloaded: same inode, no bytes transferred.
    expect(statSync(workPath).ino).toBe(statSync(keepPath).ino);
  });

  it("leaves a file that is already there alone", () => {
    cacheOneChangeset("cs1", 1);

    expect(restoreChangesetFiles(IMODEL)).toBe(0);
  });

  it("restores only the range asked for", () => {
    cacheOneChangeset("cs1", 1);
    cacheOneChangeset("cs2", 2);
    iTwinJsDeletesIt("cs1");
    iTwinJsDeletesIt("cs2");

    expect(restoreChangesetFiles(IMODEL, { start: 2, end: 2 })).toBe(1);
    expect(existsSync(join(BriefcaseManager.getChangeSetsPath(IMODEL), changesetFileName("cs2")))).toBe(true);
    expect(existsSync(join(BriefcaseManager.getChangeSetsPath(IMODEL), changesetFileName("cs1")))).toBe(false);
  });

  it("skips a changeset whose kept file has gone too", () => {
    const keepPath = cacheOneChangeset("cs1", 1);
    iTwinJsDeletesIt("cs1");
    rmSync(keepPath, { force: true });

    expect(restoreChangesetFiles(IMODEL)).toBe(0);
  });

  it("records the keep path, so nothing downstream depends on the copy iTwin.js may delete", () => {
    const keepPath = cacheOneChangeset("cs1", 1);

    expect(listCachedChangesets(IMODEL)[0].filePath).toBe(keepPath);
    expect(keepPath.includes("changeset-cache")).toBe(true);
  });
});
