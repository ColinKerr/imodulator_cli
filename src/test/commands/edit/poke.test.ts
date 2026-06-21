import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BriefcaseDb } from "@itwin/core-backend";
import { IModel } from "@itwin/core-common";
import { runEditPoke } from "../../../commands/edit/poke";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();
let cacheDir: string;

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "imod-edit-poke-cache-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
  await fixture.startup("edit-poke");
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
  rmSync(cacheDir, { recursive: true, force: true });
});

async function registeredBriefcase(name: string): Promise<TestBriefcase> {
  const briefcase = await fixture.createBriefcase(name);
  getCacheDb()
    .prepare(
      "INSERT OR REPLACE INTO downloaded_briefcases (imodel_id, briefcase_id, file_path) VALUES (?, ?, ?)",
    )
    .run(briefcase.iModelId, briefcase.briefcaseId, briefcase.fileName);
  return briefcase;
}

describe("imod edit poke", () => {
  it("updates the root model last mod and leaves a pushable changeset", async () => {
    const briefcase = await registeredBriefcase("poke");

    const before = (async () => {
      const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: true });
      try {
        return db.models.queryLastModifiedTime(IModel.repositoryModelId);
      } finally {
        db.close();
      }
    });
    const beforeLastMod = await before();

    // Ensure wall-clock advances so the new LastMod is strictly later.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const lastMod = await runEditPoke({
      imodelId: briefcase.iModelId,
      briefcaseId: briefcase.briefcaseId,
    });
    expect(new Date(lastMod).getTime()).toBeGreaterThan(new Date(beforeLastMod).getTime());

    const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: true });
    try {
      expect(db.txns.hasPendingTxns).toBe(true);
      expect(db.models.queryLastModifiedTime(IModel.repositoryModelId)).toBe(lastMod);
    } finally {
      db.close();
    }
  });

  it("throws when the briefcase is not downloaded locally", async () => {
    await expect(
      runEditPoke({ imodelId: "not-a-real-imodel", briefcaseId: 2 }),
    ).rejects.toThrow(/not downloaded locally/);
  });
});
