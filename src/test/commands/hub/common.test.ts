import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { upsertIModel } from "../../../cache/imodels";
import { resolveCheckpointTarget } from "../../../commands/hub/common";

const IMODEL = "11111111-1111-1111-1111-111111111111";
const ITWIN = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  getCacheDb().prepare("DELETE FROM imodels").run();
});

afterAll(() => {
  closeCacheDb();
});

describe("resolveCheckpointTarget", () => {
  it("takes both ids when both are given", () => {
    expect(resolveCheckpointTarget({ itwinId: ITWIN, imodelId: IMODEL })).toEqual({
      itwinId: ITWIN,
      imodelId: IMODEL,
    });
  });

  it("takes both ids from a url", () => {
    expect(
      resolveCheckpointTarget({ url: `https://example.com/itwins/${ITWIN}/imodels/${IMODEL}` }),
    ).toEqual({ itwinId: ITWIN, imodelId: IMODEL });
  });

  it("fills in the iTwin from the cache when only the iModel is named", () => {
    upsertIModel({ imodelId: IMODEL, itwinId: ITWIN, name: "Bridge" });

    expect(resolveCheckpointTarget({ imodelId: IMODEL })).toEqual({ itwinId: ITWIN, imodelId: IMODEL });
  });

  it("prefers an explicit --itwin-id over the cached one", () => {
    upsertIModel({ imodelId: IMODEL, itwinId: "cached-itwin", name: "Bridge" });

    expect(resolveCheckpointTarget({ itwinId: ITWIN, imodelId: IMODEL }).itwinId).toBe(ITWIN);
  });

  it("says what to do when the iModel is not in the cache", () => {
    expect(() => resolveCheckpointTarget({ imodelId: IMODEL })).toThrow(/not in the cache.*cache update/s);
  });

  it("still requires something to identify the iModel", () => {
    expect(() => resolveCheckpointTarget({})).toThrow(/Provide --url/);
    expect(() => resolveCheckpointTarget({ itwinId: ITWIN })).toThrow(/Provide --url/);
  });
});
