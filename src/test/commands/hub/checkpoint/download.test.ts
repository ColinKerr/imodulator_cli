import { describe, expect, it } from "vitest";
import { resolveCheckpointTarget } from "../../../../commands/hub/checkpoint/download";

const ITWIN = "11111111-1111-1111-1111-111111111111";
const IMODEL = "22222222-2222-2222-2222-222222222222";

describe("resolveCheckpointTarget", () => {
  it("uses --itwin-id and --imodel-id when --url is absent", () => {
    expect(resolveCheckpointTarget({ itwinId: ITWIN, imodelId: IMODEL })).toEqual({
      itwinId: ITWIN,
      imodelId: IMODEL,
    });
  });

  it("extracts the iTwin id then the iModel id from --url", () => {
    const url = `https://example.com/itwins/${ITWIN}/imodels/${IMODEL}?foo=bar`;
    expect(resolveCheckpointTarget({ url })).toEqual({ itwinId: ITWIN, imodelId: IMODEL });
  });

  it("prefers --url over the explicit id options", () => {
    const url = `https://example.com/${ITWIN}/${IMODEL}`;
    expect(
      resolveCheckpointTarget({ url, itwinId: "ignored", imodelId: "ignored" }),
    ).toEqual({ itwinId: ITWIN, imodelId: IMODEL });
  });

  it("throws when --url has fewer than two GUIDs", () => {
    expect(() => resolveCheckpointTarget({ url: `https://example.com/${ITWIN}` })).toThrow(
      /two GUIDs/,
    );
  });

  it("throws when neither --url nor a complete id pair is provided", () => {
    expect(() => resolveCheckpointTarget({ itwinId: ITWIN })).toThrow(/Provide --url/);
    expect(() => resolveCheckpointTarget({})).toThrow(/Provide --url/);
  });
});
