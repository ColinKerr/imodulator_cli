import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { getCachedIModel, upsertIModel, type CachedIModelDetails } from "../../../cache/imodels";
import { runCacheUpdate } from "../../../commands/cache/update";
import { HubMockFixture } from "../../hub-mock-fixture";

// runCacheUpdate starts IModelHost, so the host needs its mock authorization.
const fixture = new HubMockFixture();

/** Stand-in for the iModels API. */
const detailsFor = async (imodelId: string): Promise<CachedIModelDetails> => ({
  imodelId,
  itwinId: "itwin-1",
  name: `Name of ${imodelId}`,
  displayName: `Name of ${imodelId}`,
});

function seedDownloads(...imodelIds: string[]): void {
  const db = getCacheDb();
  for (const imodelId of imodelIds)
    db.prepare("INSERT INTO downloaded_briefcases (imodel_id, briefcase_id, file_path) VALUES (?,?,?)")
      .run(imodelId, 2, `/tmp/${imodelId}.bim`);
}

beforeAll(async () => {
  await fixture.startup("cache-update");
});

beforeEach(() => {
  const db = getCacheDb();
  for (const table of ["imodels", "downloaded_briefcases", "downloaded_checkpoints", "downloaded_manifests", "briefcase_ids"])
    db.prepare(`DELETE FROM ${table}`).run();
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

describe("imod cache update", () => {
  it("fills in details for iModels downloaded before the table existed", async () => {
    seedDownloads("a", "b");

    const result = await runCacheUpdate({}, detailsFor);

    expect(result.updated).toBe(2);
    expect(result.failed).toEqual([]);
    expect(getCachedIModel("a")?.name).toBe("Name of a");
    expect(getCachedIModel("b")?.itwinId).toBe("itwin-1");
  });

  it("refreshes details it already holds, so a rename is picked up", async () => {
    seedDownloads("a");
    upsertIModel({ imodelId: "a", itwinId: "itwin-1", name: "Old name" });

    await runCacheUpdate({}, detailsFor);

    expect(getCachedIModel("a")?.name).toBe("Name of a");
  });

  it("updates only the iModel named by --imodel-id", async () => {
    seedDownloads("a", "b");

    const result = await runCacheUpdate({ imodelId: "b" }, detailsFor);

    expect(result.updated).toBe(1);
    expect(getCachedIModel("a")).toBeUndefined();
    expect(getCachedIModel("b")).toBeDefined();
  });

  it("keeps going when one iModel cannot be fetched, and reports it", async () => {
    seedDownloads("a", "gone", "b");

    const result = await runCacheUpdate({}, async (imodelId) => {
      if (imodelId === "gone")
        throw new Error("404 Not Found");
      return detailsFor(imodelId);
    });

    expect(result.updated).toBe(2);
    expect(result.failed).toEqual([{ imodelId: "gone", reason: "404 Not Found" }]);
    expect(getCachedIModel("a")).toBeDefined();
    expect(getCachedIModel("b")).toBeDefined();
  });

  it("leaves the details it already had when the refresh of that iModel fails", async () => {
    seedDownloads("a");
    upsertIModel({ imodelId: "a", itwinId: "itwin-1", name: "Known name" });

    await runCacheUpdate({}, async () => {
      throw new Error("network down");
    });

    // Stale details beat none.
    expect(getCachedIModel("a")?.name).toBe("Known name");
  });

  it("does nothing to an empty cache", async () => {
    expect(await runCacheUpdate({}, detailsFor)).toEqual({ updated: 0, failed: [] });
  });
});
