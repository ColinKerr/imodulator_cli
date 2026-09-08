import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeCacheDb, getCacheDb } from "../../../../cache/cache-db";
import { HubMockFixture } from "../../../hub-mock-fixture";

/**
 * The details fetch goes to the real iModels API, which a test has no business calling, so the
 * fetch is replaced while the recording it drives stays real. What is under test is that the
 * download command records the iModel at all.
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
        name: "Downloaded",
        description: "what the API said",
      }));
    },
  };
});

const fixture = new HubMockFixture();

beforeAll(async () => {
  await fixture.startup("briefcase-download-details");
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

describe("imod hub briefcase download", () => {
  it("records the iModel's details alongside the downloaded briefcase", async () => {
    const { runDownloadBriefcase } = await import("../../../../commands/hub/briefcase/download");
    // An iModel with no briefcase taken yet, so this command does the downloading.
    const { iModelId, iTwinId } = await fixture.createIModel("with-details");

    await runDownloadBriefcase({ imodelId: iModelId, itwinId: iTwinId, briefcaseId: 2 });

    expect(recorded).toContain(iModelId);
    expect(
      getCacheDb().prepare("SELECT itwin_id, name, description FROM imodels WHERE imodel_id = ?").get(iModelId),
    ).toEqual({ itwin_id: "itwin-from-api", name: "Downloaded", description: "what the API said" });

    // The briefcase itself is still recorded, which is the command's own job.
    expect(
      getCacheDb().prepare("SELECT COUNT(*) AS n FROM downloaded_briefcases WHERE imodel_id = ?").get(iModelId),
    ).toEqual({ n: 1 });
  });
});
