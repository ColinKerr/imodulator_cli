import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchemaState } from "@itwin/core-common";
import { runEditUpdateProfile } from "../../../commands/edit/update-profile";
import { readProfileVersions } from "../../../commands/util/update-profile";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();
let cacheDir: string;

beforeAll(async () => {
  // Isolate the cache db (and IModelHost cache) in a temp dir for this test process.
  cacheDir = mkdtempSync(join(tmpdir(), "imod-edit-update-profile-cache-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
  await fixture.startup("edit-update-profile");
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
  rmSync(cacheDir, { recursive: true, force: true });
});

/** Create a briefcase and record it in the cache as downloaded, as the hub commands do. */
async function seedRegisteredBriefcase(name: string): Promise<TestBriefcase> {
  const briefcase = await fixture.createBriefcase(name);
  getCacheDb()
    .prepare(
      "INSERT OR REPLACE INTO downloaded_briefcases (imodel_id, briefcase_id, file_path, changeset_id) VALUES (?, ?, ?, ?)",
    )
    .run(briefcase.iModelId, briefcase.briefcaseId, briefcase.fileName, "");
  return briefcase;
}

describe("imod edit update-profile", () => {
  it("resolves the briefcase from the cache and reports its profile", async () => {
    const briefcase = await seedRegisteredBriefcase("resolve");
    const before = readProfileVersions(briefcase.fileName);

    const result = await runEditUpdateProfile({
      imodelId: briefcase.iModelId,
      briefcaseId: briefcase.briefcaseId,
    });

    // A briefcase made by the current iTwin.js is already current, so this is a no-op --
    // the point of the test is that the wrapper found the right file and ran on it.
    expect(result.schemaState).toBe(SchemaState.UpToDate);
    expect(result.changed).toBe(false);
    expect(result.before).toEqual(before);
  });

  it("dry run leaves the briefcase untouched", async () => {
    const briefcase = await seedRegisteredBriefcase("dry-run");
    const before = readProfileVersions(briefcase.fileName);

    const result = await runEditUpdateProfile({
      imodelId: briefcase.iModelId,
      briefcaseId: briefcase.briefcaseId,
      dryRun: true,
    });

    expect(result.changed).toBe(false);
    expect(readProfileVersions(briefcase.fileName)).toEqual(before);
  });

  it("throws when the briefcase is not downloaded", async () => {
    await expect(
      runEditUpdateProfile({ imodelId: "44444444-4444-4444-4444-444444444444", briefcaseId: 7 }),
    ).rejects.toThrow(/is not downloaded locally/);
  });
});
