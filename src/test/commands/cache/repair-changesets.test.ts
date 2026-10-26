import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BriefcaseManager } from "@itwin/core-backend";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { changesetFileName, changesetKeepDir } from "../../../cache/changeset-files";
import {
  listCachedChangesets, recordChangesetFile, upsertChangesetMetadata, type CachedChangeset,
} from "../../../cache/changesets";
import { runRepairChangesets, type ChangesetMetadataFetcher } from "../../../commands/cache/repair-changesets";
import { HubMockFixture } from "../../hub-mock-fixture";

// BriefcaseManager.getChangeSetsPath needs a started host to know the cache root.
const fixture = new HubMockFixture();
const IMODEL = "22222222-2222-2222-2222-222222222222";
const BYTES = "changeset bytes";

beforeEach(async () => {
  if (!existsSync(join(process.env.IMOD_CACHE_DIR!, "imodels")))
    await fixture.startup("repair-changesets");
  getCacheDb().prepare("DELETE FROM changesets").run();
  rmSync(BriefcaseManager.getIModelPath(IMODEL), { recursive: true, force: true });
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

function metadata(index: number, fileSize = BYTES.length): CachedChangeset {
  return { index, id: `cs${index}`, fileSize };
}

function writeIn(dir: string, changesetId: string, contents = BYTES): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, changesetFileName(changesetId));
  writeFileSync(filePath, contents);
  return filePath;
}

const keepDir = () => changesetKeepDir(IMODEL);
const workDir = () => BriefcaseManager.getChangeSetsPath(IMODEL);
const noFetch: ChangesetMetadataFetcher = async () => {
  throw new Error("should not fetch");
};

describe("imod cache repair-changesets", () => {
  it("records kept files the db lost track of and relinks iTwin.js's directory", async () => {
    upsertChangesetMetadata(IMODEL, [metadata(1), metadata(2)]);
    const kept = writeIn(keepDir(), "cs1");

    const { repaired } = await runRepairChangesets({}, noFetch);

    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ filesOnDisk: 1, recorded: 1, relinked: 1, adopted: 0, cleared: 0 });
    const [first, second] = listCachedChangesets(IMODEL);
    expect(first.filePath).toBe(kept);
    expect(second.filePath).toBeUndefined();
    const work = join(workDir(), changesetFileName("cs1"));
    expect(statSync(work).ino).toBe(statSync(kept).ino);
  });

  it("adopts complete files found only in iTwin.js's directory", async () => {
    upsertChangesetMetadata(IMODEL, [metadata(1)]);
    const work = writeIn(workDir(), "cs1");

    const { repaired } = await runRepairChangesets({}, noFetch);

    expect(repaired[0]).toMatchObject({ adopted: 1, recorded: 1, relinked: 0 });
    const kept = join(keepDir(), changesetFileName("cs1"));
    expect(statSync(kept).ino).toBe(statSync(work).ino);
    expect(listCachedChangesets(IMODEL)[0].filePath).toBe(kept);
  });

  it("does not record a file of the wrong size", async () => {
    upsertChangesetMetadata(IMODEL, [metadata(1, 999)]);
    const kept = writeIn(keepDir(), "cs1");

    const { repaired } = await runRepairChangesets({}, noFetch);

    expect(repaired[0].wrongSize).toEqual(["cs1"]);
    expect(listCachedChangesets(IMODEL)[0].filePath).toBeUndefined();
    expect(existsSync(kept)).toBe(true);
  });

  it("clears rows whose file is gone", async () => {
    upsertChangesetMetadata(IMODEL, [metadata(1)]);
    recordChangesetFile(IMODEL, 1, "/nowhere/cs1.cs");

    const { repaired } = await runRepairChangesets({ imodelId: IMODEL }, noFetch);

    expect(repaired[0].cleared).toBe(1);
    expect(listCachedChangesets(IMODEL)[0].filePath).toBeUndefined();
  });

  it("is a no-op the second time", async () => {
    upsertChangesetMetadata(IMODEL, [metadata(1)]);
    writeIn(keepDir(), "cs1");
    await runRepairChangesets({}, noFetch);

    const { repaired } = await runRepairChangesets({}, noFetch);

    expect(repaired[0]).toMatchObject({ filesOnDisk: 1, recorded: 0, adopted: 0, relinked: 0, cleared: 0 });
  });

  it("fetches metadata for unknown files, the whole history when resuming is not enough", async () => {
    writeIn(keepDir(), "cs1");
    const calls: boolean[] = [];
    const fetch: ChangesetMetadataFetcher = async (imodelId, refresh) => {
      calls.push(refresh);
      upsertChangesetMetadata(imodelId, refresh ? [metadata(1), metadata(2)] : [metadata(2)]);
    };

    const { repaired } = await runRepairChangesets({}, fetch);

    expect(calls).toEqual([false, true]);
    expect(repaired[0]).toMatchObject({ recorded: 1, unknown: [] });
  });

  it("offline, reports unknown files instead of fetching", async () => {
    writeIn(keepDir(), "cs1");

    const { repaired } = await runRepairChangesets({ offline: true }, noFetch);

    expect(repaired[0].unknown).toEqual(["cs1"]);
  });

  it("still repairs known files when the metadata fetch fails", async () => {
    upsertChangesetMetadata(IMODEL, [metadata(1)]);
    writeIn(keepDir(), "cs1");
    writeIn(keepDir(), "cs9");

    const result = await runRepairChangesets({}, noFetch);

    expect(result.metadataFailed).toEqual([{ imodelId: IMODEL, reason: "should not fetch" }]);
    expect(result.repaired[0]).toMatchObject({ recorded: 1, unknown: ["cs9"] });
  });
});
