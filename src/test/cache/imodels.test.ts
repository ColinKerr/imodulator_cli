import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getCacheDb, closeCacheDb } from "../../cache/cache-db";
import { getCachedIModel, listKnownIModelIds, recordIModelDetails, upsertIModel } from "../../cache/imodels";

const DETAILS = {
  imodelId: "11111111-1111-1111-1111-111111111111",
  itwinId: "22222222-2222-2222-2222-222222222222",
  name: "Bridge",
  displayName: "Bridge",
  description: "A bridge",
};

beforeEach(() => {
  const db = getCacheDb();
  for (const table of ["imodels", "downloaded_briefcases", "downloaded_checkpoints", "downloaded_manifests", "briefcase_ids"])
    db.prepare(`DELETE FROM ${table}`).run();
});

afterAll(() => {
  closeCacheDb();
});

describe("the imodels table", () => {
  it("round trips an iModel's details", () => {
    upsertIModel(DETAILS);
    expect(getCachedIModel(DETAILS.imodelId)).toEqual(DETAILS);
  });

  it("returns undefined for an iModel it does not hold", () => {
    expect(getCachedIModel("no-such-imodel")).toBeUndefined();
  });

  it("stores an absent description and display name as null, and reads them back as absent", () => {
    upsertIModel({ imodelId: "i1", itwinId: "t1", name: "Minimal" });
    expect(getCachedIModel("i1")).toEqual({ imodelId: "i1", itwinId: "t1", name: "Minimal" });
  });

  it("replaces the row when the same iModel is recorded again", () => {
    upsertIModel(DETAILS);
    upsertIModel({ ...DETAILS, name: "Renamed", description: undefined });

    expect(getCachedIModel(DETAILS.imodelId)?.name).toBe("Renamed");
    expect(getCachedIModel(DETAILS.imodelId)?.description).toBeUndefined();
    expect(getCacheDb().prepare("SELECT COUNT(*) AS n FROM imodels").get()).toEqual({ n: 1 });
  });
});

describe("listKnownIModelIds", () => {
  it("gathers ids from every table that names an iModel, without repeating any", () => {
    const db = getCacheDb();
    db.prepare("INSERT INTO downloaded_briefcases (imodel_id, briefcase_id, file_path) VALUES (?,?,?)").run("a", 2, "/tmp/a.bim");
    db.prepare("INSERT INTO downloaded_checkpoints (imodel_id, changeset_id, file_path) VALUES (?,?,?)").run("b", "cs", "/tmp/b.bim");
    db.prepare("INSERT INTO downloaded_manifests (imodel_id, file_path) VALUES (?,?)").run("c", "/tmp/c.bcv");
    db.prepare("INSERT INTO briefcase_ids (imodel_id, briefcase_id) VALUES (?,?)").run("d", 3);
    upsertIModel({ imodelId: "e", itwinId: "t", name: "E" });
    // Also in downloaded_briefcases, so it must not appear twice.
    db.prepare("INSERT INTO briefcase_ids (imodel_id, briefcase_id) VALUES (?,?)").run("a", 2);

    expect(listKnownIModelIds()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("is empty for an empty cache", () => {
    expect(listKnownIModelIds()).toEqual([]);
  });
});

describe("recordIModelDetails", () => {
  it("stores what the fetch returns", async () => {
    const result = await recordIModelDetails(DETAILS.imodelId, async () => DETAILS);

    expect(result).toEqual(DETAILS);
    expect(getCachedIModel(DETAILS.imodelId)).toEqual(DETAILS);
  });

  it("warns and carries on when the details cannot be fetched", async () => {
    // The command that called this has already done its real work; a failure here must not
    // undo it, so nothing is thrown.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await recordIModelDetails("i1", async () => {
      throw new Error("403 Forbidden");
    });

    expect(result).toBeUndefined();
    expect(getCachedIModel("i1")).toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/403 Forbidden/);
    warn.mockRestore();
  });

  it("leaves details already held alone when a later fetch fails", async () => {
    await recordIModelDetails(DETAILS.imodelId, async () => DETAILS);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await recordIModelDetails(DETAILS.imodelId, async () => {
      throw new Error("network down");
    });

    expect(getCachedIModel(DETAILS.imodelId)).toEqual(DETAILS);
    warn.mockRestore();
  });
});
