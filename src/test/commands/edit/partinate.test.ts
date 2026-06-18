import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BriefcaseDb, PhysicalModel, SpatialCategory } from "@itwin/core-backend";
import {
  Code,
  GeometryStreamBuilder,
  IModel,
  SubCategoryAppearance,
  type GeometryStreamProps,
  type PhysicalElementProps,
} from "@itwin/core-common";
import { Box, Range3d } from "@itwin/core-geometry";
import { runEditPartinate } from "../../../commands/edit/partinate";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();
let cacheDir: string;

beforeAll(async () => {
  // Isolate the cache db (and IModelHost cache) in a temp dir for this test process.
  cacheDir = mkdtempSync(join(tmpdir(), "imod-edit-partinate-cache-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
  await fixture.startup("edit-partinate");
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
  rmSync(cacheDir, { recursive: true, force: true });
});

function buildBoxGeometry(boxCount: number): GeometryStreamProps {
  const builder = new GeometryStreamBuilder();
  for (let i = 0; i < boxCount; i++) {
    const box = Box.createRange(Range3d.createXYZXYZ(0, 0, i, 1, 1, i + 1), true);
    if (box)
      builder.appendGeometry(box);
  }
  return builder.geometryStream;
}

/** Seed a briefcase with a large element and register it in the cache as downloaded. */
async function seedRegisteredBriefcase(name: string): Promise<TestBriefcase> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  try {
    const categoryId = SpatialCategory.insert(
      db,
      IModel.dictionaryId,
      `${name}-cat`,
      new SubCategoryAppearance(),
    );
    const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);
    const props: PhysicalElementProps = {
      classFullName: "Generic:PhysicalObject",
      model: modelId,
      category: categoryId,
      code: Code.createEmpty(),
      placement: { origin: [0, 0, 0], angles: {} },
      geom: buildBoxGeometry(1000),
    };
    db.elements.insertElement(props);
    db.saveChanges();
  } finally {
    db.close();
  }

  getCacheDb()
    .prepare(
      "INSERT OR REPLACE INTO downloaded_briefcases (imodel_id, briefcase_id, file_path) VALUES (?, ?, ?)",
    )
    .run(briefcase.iModelId, briefcase.briefcaseId, briefcase.fileName);

  return briefcase;
}

describe("imod edit partinate", () => {
  it("partinates a cached briefcase and leaves a pushable changeset", async () => {
    const briefcase = await seedRegisteredBriefcase("edit");

    const result = await runEditPartinate({
      imodelId: briefcase.iModelId,
      briefcaseId: briefcase.briefcaseId,
      blobSize: 1000,
    });

    expect(result.converted).toBe(1);
    expect(result.partsCreated).toBe(1);

    // The moved geometry is saved as a pending changeset ready for `imod hub briefcase push`.
    const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
    try {
      expect(db.txns.hasPendingTxns).toBe(true);
    } finally {
      db.close();
    }
  });

  it("throws when the briefcase is not downloaded locally", async () => {
    await expect(
      runEditPartinate({ imodelId: "not-a-real-imodel", briefcaseId: 2, blobSize: 1000 }),
    ).rejects.toThrow(/not downloaded locally/);
  });
});
