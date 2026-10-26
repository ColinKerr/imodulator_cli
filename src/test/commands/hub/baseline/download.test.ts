import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BaselineFile } from "@itwin/imodels-client-authoring";
import { closeCacheDb, getCacheDb } from "../../../../cache/cache-db";
import {
  baselineFilePath, runDownloadBaseline, type BaselineHub,
} from "../../../../commands/hub/baseline/download";
import { runListImodels } from "../../../../commands/cache/list/imodels";
import { HubMockFixture } from "../../../hub-mock-fixture";

// runDownloadBaseline starts IModelHost, so the host needs its mock authorization.
const fixture = new HubMockFixture();
const IMODEL = "44444444-4444-4444-4444-444444444444";
const CONTENTS = "baseline bytes";

function baseline(overrides: Partial<BaselineFile> = {}): BaselineFile {
  return {
    id: "baseline-1",
    displayName: "seed.bim",
    fileSize: CONTENTS.length,
    state: "initialized",
    _links: { creator: null, download: { href: "https://storage/seed", storageType: "azure" } },
    ...overrides,
  } as BaselineFile;
}

/** A stand-in hub that serves `contents` and counts downloads. */
function fakeHub(file: BaselineFile, contents = CONTENTS): BaselineHub & { downloads: number } {
  const hub = {
    downloads: 0,
    getBaseline: async () => file,
    download: async (_link: unknown, localPath: string, onBytes: (n: number) => void) => {
      hub.downloads++;
      writeFileSync(localPath, contents);
      onBytes(contents.length);
    },
    recordDetails: async () => {},
  };
  return hub;
}

beforeAll(async () => {
  await fixture.startup("baseline-download");
});

beforeEach(() => {
  getCacheDb().prepare("DELETE FROM downloaded_baselines").run();
  rmSync(dirname(baselineFilePath(IMODEL)), { recursive: true, force: true });
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
});

describe("imod hub baseline download", () => {
  it("downloads the baseline into the cache and records it", async () => {
    const hub = fakeHub(baseline());

    const result = await runDownloadBaseline({ imodelId: IMODEL }, hub);

    expect(result).toEqual({
      imodelId: IMODEL, filePath: baselineFilePath(IMODEL), fileSize: CONTENTS.length, downloaded: true,
    });
    expect(statSync(result.filePath).size).toBe(CONTENTS.length);
    expect(getCacheDb().prepare("SELECT baseline_id, file_size, file_path FROM downloaded_baselines").all()).toEqual([
      { baseline_id: "baseline-1", file_size: CONTENTS.length, file_path: result.filePath },
    ]);
    expect(runListImodels().find((m) => m.imodelId === IMODEL)?.baseline?.filePath).toBe(result.filePath);
  });

  it("skips the download when a complete copy is already cached", async () => {
    const hub = fakeHub(baseline());
    await runDownloadBaseline({ imodelId: IMODEL }, hub);

    const second = await runDownloadBaseline({ imodelId: IMODEL }, hub);

    expect(second.downloaded).toBe(false);
    expect(hub.downloads).toBe(1);
  });

  it("downloads again over a copy of the wrong size", async () => {
    const hub = fakeHub(baseline());
    await runDownloadBaseline({ imodelId: IMODEL }, hub);
    writeFileSync(baselineFilePath(IMODEL), "short");

    const again = await runDownloadBaseline({ imodelId: IMODEL }, hub);

    expect(again.downloaded).toBe(true);
    expect(statSync(again.filePath).size).toBe(CONTENTS.length);
  });

  it("fails, naming the state, when the baseline is not ready", async () => {
    const hub = fakeHub(baseline({ state: "waitingForFile" as BaselineFile["state"] }));

    await expect(runDownloadBaseline({ imodelId: IMODEL }, hub)).rejects.toThrow(/"waitingForFile"/);
    expect(hub.downloads).toBe(0);
  });

  it("fails when there is no download link", async () => {
    const hub = fakeHub(baseline({ _links: { creator: null, download: null } }));

    await expect(runDownloadBaseline({ imodelId: IMODEL }, hub)).rejects.toThrow(/no download link/);
  });

  it("leaves nothing behind after a short download", async () => {
    const hub = fakeHub(baseline(), "short");

    await expect(runDownloadBaseline({ imodelId: IMODEL }, hub)).rejects.toThrow(/Downloaded 5 bytes/);
    expect(existsSync(baselineFilePath(IMODEL))).toBe(false);
    expect(existsSync(`${baselineFilePath(IMODEL)}.tmp`)).toBe(false);
    expect(getCacheDb().prepare("SELECT COUNT(*) AS n FROM downloaded_baselines").get()).toEqual({ n: 0 });
  });

  it("needs an iModel id or a URL", async () => {
    await expect(runDownloadBaseline({}, fakeHub(baseline()))).rejects.toThrow(/--imodel-id or --url/);
  });
});
