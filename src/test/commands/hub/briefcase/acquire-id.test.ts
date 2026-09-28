import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeCacheDb, getCacheDb } from "../../../../cache/cache-db";
import { HubMockFixture } from "../../../hub-mock-fixture";

/**
 * The details fetch goes to the real iModels API, which a test has no business calling, so the
 * fetch is replaced while the recording it drives stays real.
 */
const recorded: string[] = [];
vi.mock("../../../../cache/imodels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../cache/imodels")>();
  return {
    ...actual,
    recordIModelDetails: async (imodelId: string) => {
      recorded.push(imodelId);
      return actual.recordIModelDetails(imodelId, async () => ({
        imodelId,
        itwinId: "itwin-from-api",
        name: "Acquired",
      }));
    },
  };
});

const fixture = new HubMockFixture();

beforeAll(async () => {
  await fixture.startup("acquire-id");
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

describe("imod hub briefcase acquire-id", () => {
  it("acquires an id from the hub and records it", async () => {
    const { runacquireId } = await import("../../../../commands/hub/briefcase/acquire-id");
    const { iModelId } = await fixture.createIModel("acquire");

    const briefcaseId = await runacquireId({ imodelId: iModelId });

    expect(briefcaseId).toBeGreaterThan(0);
    expect(
      getCacheDb().prepare("SELECT briefcase_id FROM briefcase_ids WHERE imodel_id = ?").get(iModelId),
    ).toEqual({ briefcase_id: briefcaseId });
  });

  it("records the iModel's details, which is the only way it learns the iTwin", async () => {
    const { runacquireId } = await import("../../../../commands/hub/briefcase/acquire-id");
    const { iModelId } = await fixture.createIModel("acquire-details");

    await runacquireId({ imodelId: iModelId });

    expect(recorded).toContain(iModelId);
    expect(
      getCacheDb().prepare("SELECT itwin_id, name FROM imodels WHERE imodel_id = ?").get(iModelId),
    ).toEqual({ itwin_id: "itwin-from-api", name: "Acquired" });
  });

  it("hands out a different id each time it is asked", async () => {
    const { runacquireId } = await import("../../../../commands/hub/briefcase/acquire-id");
    const { iModelId } = await fixture.createIModel("acquire-twice");

    const first = await runacquireId({ imodelId: iModelId });
    const second = await runacquireId({ imodelId: iModelId });

    expect(second).not.toBe(first);
    // Both are kept: the table's key is (imodel_id, briefcase_id), not the iModel alone.
    expect(
      getCacheDb().prepare("SELECT COUNT(*) AS n FROM briefcase_ids WHERE imodel_id = ?").get(iModelId),
    ).toEqual({ n: 2 });
  });
});
