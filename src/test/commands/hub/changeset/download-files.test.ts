import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BriefcaseManager } from "@itwin/core-backend";
import { closeCacheDb, getCacheDb } from "../../../../cache/cache-db";
import { upsertChangesetMetadata } from "../../../../cache/changesets";
import { runDownloadChangesetFiles } from "../../../../commands/hub/changeset/download-files";
import { HubMockFixture } from "../../../hub-mock-fixture";

// The keep/restore machinery has its own tests; here it would only put real files in the way.
vi.mock("../../../../cache/changeset-files", () => ({
  keepChangesetFile: (_imodelId: string, changesetId: string) => `/tmp/keep/${changesetId}.cs`,
  restoreChangesetFiles: () => 0,
}));

// The command starts IModelHost and asks BriefcaseManager for the changesets directory.
const fixture = new HubMockFixture();
const IMODEL = "11111111-1111-1111-1111-111111111111";
const ITWIN = "22222222-2222-2222-2222-222222222222";

/** The ranges handed to the hub, which is what chunking is about. */
let requested: { first: number; end?: number }[] = [];

beforeAll(async () => {
  await fixture.startup("download-files");
});

beforeEach(() => {
  getCacheDb().prepare("DELETE FROM changesets").run();
  requested = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  // The download itself is the hub's; what is under test is the ranges asked for and what is
  // recorded afterwards.
  vi.spyOn(BriefcaseManager, "downloadChangesets").mockImplementation(async (arg: any) => {
    requested.push({ first: arg.range.first, end: arg.range.end });
    const files = [];
    for (let index = arg.range.first; index <= arg.range.end; index++)
      files.push({ index, id: `cs${index}`, pathname: `/tmp/fake/cs${index}.cs` } as any);
    return files;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

function cacheMetadata(count: number): void {
  upsertChangesetMetadata(
    IMODEL,
    Array.from({ length: count }, (_, i) => ({ index: i + 1, id: `cs${i + 1}`, fileSize: 10 })),
  );
}

describe("downloading changeset files in chunks", () => {
  it("asks for one range when the span fits in a chunk", async () => {
    cacheMetadata(10);

    await runDownloadChangesetFiles({ imodelId: IMODEL, itwinId: ITWIN, start: 1, end: 10 });

    expect(requested).toEqual([{ first: 1, end: 10 }]);
  });

  it("splits a large span into chunks of 1000", async () => {
    // The client holds every changeset of the range it is given in one array, so the range it
    // is handed is bounded rather than passed straight through.
    cacheMetadata(2500);

    await runDownloadChangesetFiles({ imodelId: IMODEL, itwinId: ITWIN });

    expect(requested).toEqual([
      { first: 1, end: 1000 },
      { first: 1001, end: 2000 },
      { first: 2001, end: 2500 },
    ]);
  });

  it("chunks from the start of the range asked for, not from index 1", async () => {
    cacheMetadata(2500);

    await runDownloadChangesetFiles({ imodelId: IMODEL, itwinId: ITWIN, start: 1500, end: 2500 });

    expect(requested).toEqual([
      { first: 1500, end: 2499 },
      { first: 2500, end: 2500 },
    ]);
  });

  it("records every chunk's files, not just the last", async () => {
    cacheMetadata(2500);

    const result = await runDownloadChangesetFiles({ imodelId: IMODEL, itwinId: ITWIN });

    expect(result.downloaded).toBe(2500);
    const recorded = getCacheDb()
      .prepare("SELECT COUNT(*) AS n FROM changesets WHERE imodel_id = ? AND file_path IS NOT NULL")
      .get(IMODEL);
    expect(recorded).toEqual({ n: 2500 });
  });

  it("keeps what earlier chunks got when a later one fails", async () => {
    // An interrupted download of a huge range should not throw away the chunks that finished.
    cacheMetadata(2500);
    vi.mocked(BriefcaseManager.downloadChangesets).mockImplementation(async (arg: any) => {
      if (arg.range.first > 1000)
        throw new Error("network died");
      requested.push({ first: arg.range.first, end: arg.range.end });
      const files = [];
      for (let index = arg.range.first; index <= arg.range.end; index++)
        files.push({ index, id: `cs${index}`, pathname: `/tmp/fake/cs${index}.cs` } as any);
      return files;
    });

    await expect(runDownloadChangesetFiles({ imodelId: IMODEL, itwinId: ITWIN })).rejects.toThrow(/network died/);

    const recorded = getCacheDb()
      .prepare("SELECT COUNT(*) AS n FROM changesets WHERE imodel_id = ? AND file_path IS NOT NULL")
      .get(IMODEL);
    expect(recorded).toEqual({ n: 1000 });
  });
});
