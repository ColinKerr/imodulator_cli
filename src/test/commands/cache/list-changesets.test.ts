import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { recordChangesetFile, upsertChangesetMetadata } from "../../../cache/changesets";
import { runListChangesets } from "../../../commands/cache/list/changesets";
import { runListDb } from "../../../commands/cache/list/db";

const IMODEL = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  getCacheDb().prepare("DELETE FROM changesets").run();
  upsertChangesetMetadata(
    IMODEL,
    [1, 2, 3, 4].map((index) => ({ index, id: `cs${index}`, fileSize: 1000 })),
  );
});

afterAll(() => {
  closeCacheDb();
});

describe("imod cache list changesets", () => {
  it("lists every cached changeset with its totals", () => {
    const result = runListChangesets({ imodelId: IMODEL });

    expect(result.changesets.map((c) => c.index)).toEqual([1, 2, 3, 4]);
    expect(result).toMatchObject({ count: 4, withFile: 0, totalBytes: 4000, missingBytes: 4000 });
  });

  it("limits the listing to a range", () => {
    const result = runListChangesets({ imodelId: IMODEL, start: 2, end: 3 });

    expect(result.changesets.map((c) => c.index)).toEqual([2, 3]);
    expect(result.count).toBe(2);
  });

  it("can show only what has been downloaded, while still costing the whole range", () => {
    recordChangesetFile(IMODEL, 2, "/tmp/cs2.cs");

    const result = runListChangesets({ imodelId: IMODEL, downloadedOnly: true });

    expect(result.changesets.map((c) => c.index)).toEqual([2]);
    // The counts describe the range, not the rows shown, so the missing bytes stay honest.
    expect(result).toMatchObject({ count: 4, withFile: 1, missingBytes: 3000 });
  });

  it("reports an iModel it holds no changesets for", () => {
    expect(runListChangesets({ imodelId: "unknown" })).toMatchObject({ count: 0, changesets: [] });
  });
});

describe("imod cache list db", () => {
  it("omits the changesets table, which would bury every other one", () => {
    const names = runListDb().map((table) => table.name);

    expect(names).not.toContain("changesets");
    expect(names).toContain("downloaded_briefcases");
    expect(names).toContain("imodels");
    // The rows are there; they are just not dumped.
    expect(getCacheDb().prepare("SELECT COUNT(*) AS n FROM changesets").get()).toEqual({ n: 4 });
  });
});

describe("listing at scale", () => {
  beforeEach(() => {
    getCacheDb().prepare("DELETE FROM changesets").run();
    upsertChangesetMetadata(
      IMODEL,
      Array.from({ length: 500 }, (_, i) => ({ index: i + 1, id: `cs${i + 1}`, fileSize: 1000 })),
    );
  });

  it("prints a window by default rather than every changeset", () => {
    // Half a million rows measured at 954 MiB and a 48.6 MiB table, built before anything is
    // printed. The default is a window onto the range.
    const result = runListChangesets({ imodelId: IMODEL });

    expect(result.changesets).toHaveLength(200);
    expect(result.truncated).toBe(true);
    // The counts still describe the whole range, not the window.
    expect(result.count).toBe(500);
    expect(result.totalBytes).toBe(500_000);
  });

  it("takes an explicit limit", () => {
    const result = runListChangesets({ imodelId: IMODEL, limit: 5 });

    expect(result.changesets.map((c) => c.index)).toEqual([1, 2, 3, 4, 5]);
    expect(result.truncated).toBe(true);
  });

  it("prints everything when the limit is 0", () => {
    const result = runListChangesets({ imodelId: IMODEL, limit: 0 });

    expect(result.changesets).toHaveLength(500);
    expect(result.truncated).toBe(false);
  });

  it("is not truncated when the range fits inside the limit", () => {
    const result = runListChangesets({ imodelId: IMODEL, start: 1, end: 10 });

    expect(result.changesets).toHaveLength(10);
    expect(result.truncated).toBe(false);
  });

  it("limits the downloaded-only listing too, without filtering a full list", () => {
    for (let index = 1; index <= 20; index++)
      recordChangesetFile(IMODEL, index, `/tmp/cs${index}.cs`);

    const result = runListChangesets({ imodelId: IMODEL, downloadedOnly: true, limit: 5 });

    expect(result.changesets).toHaveLength(5);
    expect(result.changesets.every((c) => c.filePath !== undefined)).toBe(true);
    expect(result.withFile).toBe(20);
  });
});
