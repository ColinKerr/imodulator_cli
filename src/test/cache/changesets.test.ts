import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeCacheDb, getCacheDb } from "../../cache/cache-db";
import {
  changesetIndexForId, clearChangesetFile, highestCachedIndex, iterateCachedChangesets,
  listCachedChangesets, recordChangesetFile, recordChangesetFiles, summarizeChangesets,
  upsertChangesetMetadata, type CachedChangeset,
} from "../../cache/changesets";

const IMODEL = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function changeset(index: number, fileSize = 1024): CachedChangeset {
  return {
    index,
    id: `cs${index}`,
    parentId: index === 1 ? "" : `cs${index - 1}`,
    description: `change ${index}`,
    pushDateTime: "2024-01-01T00:00:00Z",
    briefcaseId: 2,
    fileSize,
    containingChanges: 0,
    state: "fileUploaded",
    creatorId: "user-1",
  };
}

beforeEach(() => {
  getCacheDb().prepare("DELETE FROM changesets").run();
});

afterAll(() => {
  closeCacheDb();
});

describe("changeset metadata", () => {
  it("records and reads back a changeset in index order", () => {
    upsertChangesetMetadata(IMODEL, [changeset(3), changeset(1), changeset(2)]);

    expect(listCachedChangesets(IMODEL).map((c) => c.index)).toEqual([1, 2, 3]);
    expect(listCachedChangesets(IMODEL)[0]).toMatchObject({
      index: 1, id: "cs1", description: "change 1", fileSize: 1024, briefcaseId: 2,
    });
  });

  it("keeps each iModel's changesets apart", () => {
    upsertChangesetMetadata(IMODEL, [changeset(1)]);
    upsertChangesetMetadata(OTHER, [changeset(1), changeset(2)]);

    expect(listCachedChangesets(IMODEL)).toHaveLength(1);
    expect(listCachedChangesets(OTHER)).toHaveLength(2);
  });

  it("has no file until one is recorded", () => {
    upsertChangesetMetadata(IMODEL, [changeset(1)]);
    expect(listCachedChangesets(IMODEL)[0].filePath).toBeUndefined();

    recordChangesetFile(IMODEL, 1, "/tmp/cs1.cs");

    const cached = listCachedChangesets(IMODEL)[0];
    expect(cached.filePath).toBe("/tmp/cs1.cs");
    expect(cached.downloadedAt).toBeDefined();
  });

  it("does not lose a recorded file when metadata is fetched again", () => {
    // Metadata is refetched whole, so a re-sync must not blank the files already downloaded.
    upsertChangesetMetadata(IMODEL, [changeset(1)]);
    recordChangesetFile(IMODEL, 1, "/tmp/cs1.cs");

    upsertChangesetMetadata(IMODEL, [{ ...changeset(1), description: "renamed" }]);

    const cached = listCachedChangesets(IMODEL)[0];
    expect(cached.description).toBe("renamed");
    expect(cached.filePath).toBe("/tmp/cs1.cs");
  });

  it("forgets a file without forgetting the changeset", () => {
    upsertChangesetMetadata(IMODEL, [changeset(1)]);
    recordChangesetFile(IMODEL, 1, "/tmp/cs1.cs");

    clearChangesetFile(IMODEL, 1);

    expect(listCachedChangesets(IMODEL)).toHaveLength(1);
    expect(listCachedChangesets(IMODEL)[0].filePath).toBeUndefined();
  });

  it("finds a changeset's index from its id", () => {
    upsertChangesetMetadata(IMODEL, [changeset(1), changeset(2)]);

    expect(changesetIndexForId(IMODEL, "cs2")).toBe(2);
    expect(changesetIndexForId(IMODEL, "nope")).toBeUndefined();
  });

  it("reports the highest index it holds", () => {
    expect(highestCachedIndex(IMODEL)).toBeUndefined();
    upsertChangesetMetadata(IMODEL, [changeset(1), changeset(7)]);
    expect(highestCachedIndex(IMODEL)).toBe(7);
  });
});

describe("ranges", () => {
  beforeEach(() => {
    upsertChangesetMetadata(IMODEL, [1, 2, 3, 4, 5].map((i) => changeset(i, i * 1000)));
  });

  it("is inclusive at both ends, as the hub's range is", () => {
    expect(listCachedChangesets(IMODEL, { start: 2, end: 4 }).map((c) => c.index)).toEqual([2, 3, 4]);
  });

  it("takes an open start or end", () => {
    expect(listCachedChangesets(IMODEL, { end: 2 }).map((c) => c.index)).toEqual([1, 2]);
    expect(listCachedChangesets(IMODEL, { start: 4 }).map((c) => c.index)).toEqual([4, 5]);
  });
});

describe("summarizeChangesets", () => {
  beforeEach(() => {
    upsertChangesetMetadata(IMODEL, [1, 2, 3].map((i) => changeset(i, 1000)));
  });

  it("costs a range before anything is downloaded", () => {
    // file_size comes with the metadata, so the cost of a download is known without asking
    // the hub anything.
    expect(summarizeChangesets(IMODEL)).toEqual({
      count: 3, withFile: 0, totalBytes: 3000, missingBytes: 3000, minIndex: 1, maxIndex: 3,
    });
  });

  it("counts what is still missing as files arrive", () => {
    recordChangesetFile(IMODEL, 2, "/tmp/cs2.cs");

    expect(summarizeChangesets(IMODEL)).toMatchObject({
      count: 3, withFile: 1, totalBytes: 3000, missingBytes: 2000,
    });
  });

  it("summarizes only the range asked for", () => {
    expect(summarizeChangesets(IMODEL, { start: 2, end: 3 })).toMatchObject({
      count: 2, totalBytes: 2000, minIndex: 2, maxIndex: 3,
    });
  });

  it("reports an empty range rather than failing", () => {
    expect(summarizeChangesets(IMODEL, { start: 50, end: 60 })).toEqual({
      count: 0, withFile: 0, totalBytes: 0, missingBytes: 0, minIndex: undefined, maxIndex: undefined,
    });
  });
});

describe("iterateCachedChangesets", () => {
  beforeEach(() => {
    upsertChangesetMetadata(IMODEL, [1, 2, 3, 4, 5].map((i) => changeset(i)));
  });

  it("yields the same changesets as listing them, in index order", () => {
    // The streaming form exists so a range of hundreds of thousands need not be held at once;
    // it must agree with the array form exactly.
    expect([...iterateCachedChangesets(IMODEL)]).toEqual(listCachedChangesets(IMODEL));
  });

  it("honours a range", () => {
    expect([...iterateCachedChangesets(IMODEL, { start: 2, end: 3 })].map((c) => c.index)).toEqual([2, 3]);
  });

  it("can be stopped early without reading the rest", () => {
    const seen: number[] = [];
    for (const c of iterateCachedChangesets(IMODEL)) {
      seen.push(c.index);
      if (seen.length === 2)
        break;
    }
    expect(seen).toEqual([1, 2]);
  });
});

describe("limits", () => {
  beforeEach(() => {
    upsertChangesetMetadata(IMODEL, [1, 2, 3, 4, 5].map((i) => changeset(i)));
  });

  it("takes the first N in index order", () => {
    expect(listCachedChangesets(IMODEL, {}, { limit: 2 }).map((c) => c.index)).toEqual([1, 2]);
  });

  it("applies the limit within a range", () => {
    expect(listCachedChangesets(IMODEL, { start: 3 }, { limit: 2 }).map((c) => c.index)).toEqual([3, 4]);
  });

  it("returns everything when no limit is given", () => {
    expect(listCachedChangesets(IMODEL)).toHaveLength(5);
  });
});

describe("recordChangesetFiles", () => {
  it("records many files in one transaction", () => {
    upsertChangesetMetadata(IMODEL, [1, 2, 3].map((i) => changeset(i)));

    recordChangesetFiles(IMODEL, [
      { changesetIndex: 1, filePath: "/tmp/a.cs" },
      { changesetIndex: 3, filePath: "/tmp/c.cs" },
    ]);

    expect(listCachedChangesets(IMODEL).map((c) => c.filePath)).toEqual(["/tmp/a.cs", undefined, "/tmp/c.cs"]);
  });

  it("does nothing given nothing", () => {
    upsertChangesetMetadata(IMODEL, [changeset(1)]);
    expect(() => recordChangesetFiles(IMODEL, [])).not.toThrow();
  });
});
