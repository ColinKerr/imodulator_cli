import { describe, expect, it } from "vitest";
import type { V2CheckpointAccessProps } from "@itwin/core-backend";
import {
  buildManifestUrl,
  decideManifestAction,
  MANIFEST_FILE_NAME,
} from "../../../../commands/hub/manifest/download";

function v2props(overrides: Partial<V2CheckpointAccessProps> = {}): V2CheckpointAccessProps {
  return {
    accountName: "imodelhubprod",
    containerId: "imodelblocks-33333333-3333-3333-3333-333333333333",
    dbName: "44444444-4444-4444-4444-444444444444",
    sasToken: "sv=2023-01-01&sig=abc123",
    storageType: "azure",
    ...overrides,
  };
}

describe("buildManifestUrl", () => {
  it("addresses the manifest at the root of the iModel's container", () => {
    expect(buildManifestUrl(v2props())).toBe(
      `https://imodelhubprod.blob.core.windows.net/imodelblocks-33333333-3333-3333-3333-333333333333/${MANIFEST_FILE_NAME}?sv=2023-01-01&sig=abc123`,
    );
  });

  it("does not double up the query separator when the token carries one", () => {
    const url = buildManifestUrl(v2props({ sasToken: "?sv=2023-01-01&sig=abc123" }));
    expect(url).toContain(`${MANIFEST_FILE_NAME}?sv=`);
    expect(url).not.toContain("??");
  });

  it("accepts a storage type carrying URI-style parameters", () => {
    expect(() => buildManifestUrl(v2props({ storageType: "azure?sas=1" }))).not.toThrow();
  });

  it("refuses storage types it cannot address", () => {
    for (const storageType of ["google", "aws"])
      expect(() => buildManifestUrl(v2props({ storageType }))).toThrow(/only azure/);
  });
});

describe("decideManifestAction", () => {
  const ETAG = '"0x8DDAA1B2C3D4E5F"';

  it("downloads when nothing is cached", () => {
    expect(decideManifestAction({ fileExists: false })).toBe("download");
  });

  it("downloads when the cache db has a row but the file is gone", () => {
    expect(decideManifestAction({ cachedEtag: ETAG, fileExists: false })).toBe("download");
  });

  it("reuses the cached copy when the container reports the same ETag", () => {
    expect(decideManifestAction({ cachedEtag: ETAG, fileExists: true, remoteEtag: ETAG }))
      .toBe("upToDate");
  });

  it("leaves a changed manifest alone unless --update is passed", () => {
    const state = { cachedEtag: ETAG, fileExists: true, remoteEtag: '"0xNEWER"' };
    expect(decideManifestAction(state)).toBe("stale");
    expect(decideManifestAction({ ...state, update: true })).toBe("download");
  });

  it("treats an unverifiable copy as out of date rather than current", () => {
    // No remote ETag (the container rejected HEAD), or none was recorded locally.
    expect(decideManifestAction({ cachedEtag: ETAG, fileExists: true })).toBe("stale");
    expect(decideManifestAction({ fileExists: true, remoteEtag: ETAG })).toBe("stale");
    expect(decideManifestAction({ cachedEtag: ETAG, fileExists: true, update: true }))
      .toBe("download");
  });

  it("does not re-download an up-to-date manifest just because --update was passed", () => {
    expect(decideManifestAction({ cachedEtag: ETAG, fileExists: true, remoteEtag: ETAG, update: true }))
      .toBe("upToDate");
  });
});
