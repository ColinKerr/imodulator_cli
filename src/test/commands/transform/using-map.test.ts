import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { runUsingMap } from "../../../commands/transform/using-map";
import { closeCacheDb, getCacheDb } from "../../../cache/cache-db";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();
let cacheDir: string;
let workDir: string;
let schemaFile: string;
let mapFile: string;

const SCHEMA = `<?xml version="1.0" encoding="UTF-8"?>
<ECSchema schemaName="TransformTest" alias="tt" version="01.00.00" xmlns="http://www.bentley.com/schemas/Bentley.ECXML.3.2">
  <ECSchemaReference name="BisCore" version="01.00.00" alias="bis"/>
  <ECEntityClass typeName="SourceObject" modifier="None">
    <BaseClass>bis:PhysicalElement</BaseClass>
    <ECProperty propertyName="Banana" typeName="string"/>
  </ECEntityClass>
  <ECEntityClass typeName="TargetObject" modifier="None">
    <BaseClass>bis:PhysicalElement</BaseClass>
    <ECProperty propertyName="Apple" typeName="string"/>
  </ECEntityClass>
</ECSchema>`;

const MAPPING = {
  ElementMapping: {
    ClassMappings: [
      {
        SourceClass: "TransformTest:SourceObject",
        TargetClass: "TransformTest:TargetObject",
        PropertyMappings: [{ SourceProperty: "Banana", TargetProperty: "Apple" }],
      },
    ],
  },
};

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "imod-using-map-cache-"));
  process.env.IMOD_CACHE_DIR = cacheDir;
  await fixture.startup("using-map");
  workDir = mkdtempSync(join(tmpdir(), "imod-using-map-work-"));
  schemaFile = join(workDir, "TransformTest.ecschema.xml");
  writeFileSync(schemaFile, SCHEMA, "utf8");
  mapFile = join(workDir, "map.json");
  writeFileSync(mapFile, JSON.stringify(MAPPING), "utf8");
});

afterAll(async () => {
  closeCacheDb();
  await fixture.shutdown();
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function boxGeom(): GeometryStreamProps {
  const builder = new GeometryStreamBuilder();
  const box = Box.createRange(Range3d.createXYZXYZ(0, 0, 0, 1, 1, 1), true);
  if (box) builder.appendGeometry(box);
  return builder.geometryStream;
}

/** Create a briefcase with the test schema and `count` SourceObjects, registered as downloaded. */
async function registeredBriefcase(name: string, count: number): Promise<TestBriefcase> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  try {
    await db.acquireSchemaLock();
    await db.importSchemas([schemaFile]);
    const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, `${name}-cat`, new SubCategoryAppearance());
    const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);
    for (let i = 0; i < count; i++) {
      const props: PhysicalElementProps = {
        classFullName: "TransformTest:SourceObject",
        model: modelId,
        category: categoryId,
        code: Code.createEmpty(),
        placement: { origin: [0, 0, i], angles: {} },
        geom: boxGeom(),
      };
      (props as Record<string, unknown>).banana = "b";
      db.elements.insertElement(props);
    }
    db.saveChanges();
  } finally {
    db.close();
  }
  getCacheDb()
    .prepare("INSERT OR REPLACE INTO downloaded_briefcases (imodel_id, briefcase_id, file_path) VALUES (?, ?, ?)")
    .run(briefcase.iModelId, briefcase.briefcaseId, briefcase.fileName);
  return briefcase;
}

async function countInBriefcase(fileName: string, fromClause: string): Promise<number> {
  const db = await BriefcaseDb.open({ fileName, readonly: true });
  try {
    return db.withPreparedStatement(`SELECT COUNT(*) FROM ${fromClause}`, (s) => {
      s.step();
      return s.getValue(0).getInteger();
    });
  } finally {
    db.close();
  }
}

describe("imod transform using-map", () => {
  it("dry run reports counts grouped by source class without modifying the briefcase", async () => {
    const briefcase = await registeredBriefcase("dry", 3);

    const result = await runUsingMap({
      imodelId: briefcase.iModelId,
      briefcaseId: briefcase.briefcaseId,
      mapFile,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    if (result.dryRun) {
      expect(result.total).toBe(3);
      expect(result.classMappings).toEqual([
        { sourceClass: "TransformTest:SourceObject", targetClass: "TransformTest:TargetObject", count: 3 },
      ]);
    }
    // No conversion happened.
    expect(await countInBriefcase(briefcase.fileName, "ONLY TransformTest.SourceObject")).toBe(3);
    expect(await countInBriefcase(briefcase.fileName, "ONLY TransformTest.TargetObject")).toBe(0);
  });

  it("converts elements to the target class and leaves a pushable changeset", async () => {
    const briefcase = await registeredBriefcase("convert", 2);

    const result = await runUsingMap({
      imodelId: briefcase.iModelId,
      briefcaseId: briefcase.briefcaseId,
      mapFile,
      dryRun: false,
    });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun)
      expect(result.converted).toBe(2);

    expect(await countInBriefcase(briefcase.fileName, "ONLY TransformTest.SourceObject")).toBe(0);
    expect(await countInBriefcase(briefcase.fileName, "ONLY TransformTest.TargetObject")).toBe(2);

    const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: true });
    try {
      expect(db.txns.hasPendingTxns).toBe(true);
    } finally {
      db.close();
    }
  });

  it("throws when the briefcase is not downloaded locally", async () => {
    await expect(
      runUsingMap({ imodelId: "not-a-real-imodel", briefcaseId: 2, mapFile, dryRun: true }),
    ).rejects.toThrow(/not downloaded locally/);
  });

  it("throws for a malformed mapping file", async () => {
    const bad = join(workDir, "bad.json");
    writeFileSync(bad, "{ not json", "utf8");
    await expect(
      runUsingMap({ imodelId: "x", briefcaseId: 2, mapFile: bad, dryRun: true }),
    ).rejects.toThrow(/not valid JSON/);
  });
});
