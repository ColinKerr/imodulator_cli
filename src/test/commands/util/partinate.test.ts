import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BriefcaseDb,
  PhysicalModel,
  SpatialCategory,
} from "@itwin/core-backend";
import { DbResult } from "@itwin/core-bentley";
import {
  Code,
  GeometryStreamBuilder,
  IModel,
  SubCategoryAppearance,
  type GeometryStreamProps,
  type PhysicalElementProps,
} from "@itwin/core-common";
import { Box, Range3d } from "@itwin/core-geometry";
import { runPartinate } from "../../../commands/util/partinate";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();

beforeAll(async () => {
  await fixture.startup("partinate");
});

afterAll(async () => {
  await fixture.shutdown();
});

/** A geometry stream of `boxCount` stacked boxes, used to inflate the stored blob. */
function buildBoxGeometry(boxCount: number): GeometryStreamProps {
  const builder = new GeometryStreamBuilder();
  for (let i = 0; i < boxCount; i++) {
    const box = Box.createRange(Range3d.createXYZXYZ(0, 0, i, 1, 1, i + 1), true);
    if (box)
      builder.appendGeometry(box);
  }
  return builder.geometryStream;
}

function insertPhysicalObject(
  db: BriefcaseDb,
  modelId: string,
  categoryId: string,
  geom: GeometryStreamProps,
): string {
  const props: PhysicalElementProps = {
    classFullName: "Generic:PhysicalObject",
    model: modelId,
    category: categoryId,
    code: Code.createEmpty(),
    placement: { origin: [0, 0, 0], angles: {} },
    geom,
  };
  return db.elements.insertElement(props);
}

function geometryBlobLength(db: BriefcaseDb, elementId: string): number {
  return db.withSqliteStatement(
    "SELECT length(GeometryStream) FROM bis_GeometricElement3d WHERE ElementId = ?",
    (stmt) => {
      stmt.bindId(1, elementId);
      if (stmt.step() !== DbResult.BE_SQLITE_ROW)
        throw new Error(`element ${elementId} not found`);
      return stmt.getValueInteger(0);
    },
  );
}

async function countGeometryParts(db: BriefcaseDb): Promise<number> {
  const reader = db.createQueryReader("SELECT COUNT(*) FROM BisCore.GeometryPart");
  const rows = await reader.toArray();
  return Number(rows[0][0]);
}

function geometryPartReferences(geom: GeometryStreamProps | undefined): string[] {
  if (!geom)
    return [];
  return geom
    .filter((entry) => entry.geomPart !== undefined)
    .map((entry) => entry.geomPart!.part);
}

/** Open a fresh briefcase with one large and one small geometric element. */
async function seedBriefcase(name: string): Promise<{
  briefcase: TestBriefcase;
  bigId: string;
  smallId: string;
  bigLen: number;
  smallLen: number;
}> {
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
    const bigId = insertPhysicalObject(db, modelId, categoryId, buildBoxGeometry(1000));
    const smallId = insertPhysicalObject(db, modelId, categoryId, buildBoxGeometry(1));
    db.saveChanges();
    return {
      briefcase,
      bigId,
      smallId,
      bigLen: geometryBlobLength(db, bigId),
      smallLen: geometryBlobLength(db, smallId),
    };
  } finally {
    db.close();
  }
}

describe("imod util partinate", () => {
  it("moves a large element's geometry into a GeometryPart it then references", async () => {
    const { briefcase, bigId, smallId, bigLen, smallLen } = await seedBriefcase("convert");
    expect(bigLen).toBeGreaterThan(smallLen);
    const blobSize = Math.floor((smallLen + bigLen) / 2);

    const partsBefore = await withReadonly(briefcase.fileName, countGeometryParts);

    const result = await runPartinate({ imodelPath: briefcase.fileName, blobSize });

    expect(result.converted).toBe(1);
    expect(result.partsCreated).toBe(1);

    await withReadonly(briefcase.fileName, async (db) => {
      expect(await countGeometryParts(db)).toBe(partsBefore + 1);

      const bigProps = db.elements.getElementProps<PhysicalElementProps>({
        id: bigId,
        wantGeometry: true,
      });
      const refs = geometryPartReferences(bigProps.geom);
      expect(refs).toHaveLength(1);
      // The referenced part must actually exist.
      const partProps = db.elements.getElementProps({ id: refs[0], wantGeometry: true });
      expect(partProps.classFullName).toBe("BisCore:GeometryPart");

      // The below-threshold element is untouched (still raw geometry, no part ref).
      const smallProps = db.elements.getElementProps<PhysicalElementProps>({
        id: smallId,
        wantGeometry: true,
      });
      expect(geometryPartReferences(smallProps.geom)).toHaveLength(0);
    });
  });

  it("is idempotent: a second run converts nothing", async () => {
    const { briefcase, smallLen, bigLen } = await seedBriefcase("idempotent");
    const blobSize = Math.floor((smallLen + bigLen) / 2);

    const first = await runPartinate({ imodelPath: briefcase.fileName, blobSize });
    expect(first.converted).toBe(1);

    const second = await runPartinate({ imodelPath: briefcase.fileName, blobSize });
    expect(second.converted).toBe(0);
    expect(second.partsCreated).toBe(0);
  });

  it("skips a large element that already references a GeometryPart", async () => {
    const briefcase = await fixture.createBriefcase("skip");
    let elementId: string;
    const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
    try {
      const categoryId = SpatialCategory.insert(
        db,
        IModel.dictionaryId,
        "skip-cat",
        new SubCategoryAppearance(),
      );
      const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, "skip-model");

      // A real GeometryPart to reference.
      const partId = db.elements.insertElement({
        classFullName: "BisCore:GeometryPart",
        model: IModel.dictionaryId,
        code: Code.createEmpty(),
        geom: buildBoxGeometry(1),
      });

      // An element whose stream already references the part *and* carries enough
      // additional geometry to exceed the threshold.
      const builder = new GeometryStreamBuilder();
      builder.appendGeometryPart3d(partId);
      for (let i = 0; i < 1000; i++) {
        const box = Box.createRange(Range3d.createXYZXYZ(0, 0, i, 1, 1, i + 1), true);
        if (box)
          builder.appendGeometry(box);
      }
      elementId = insertPhysicalObject(db, modelId, categoryId, builder.geometryStream);
      db.saveChanges();
    } finally {
      db.close();
    }

    const partsBefore = await withReadonly(briefcase.fileName, countGeometryParts);

    const result = await runPartinate({ imodelPath: briefcase.fileName, blobSize: 1000 });

    expect(result.converted).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    // No new part should have been created.
    expect(await withReadonly(briefcase.fileName, countGeometryParts)).toBe(partsBefore);
  });

  it("throws when the iModel file does not exist", async () => {
    await expect(
      runPartinate({ imodelPath: "/no/such/imodel.bim", blobSize: 1024 }),
    ).rejects.toThrow(/not found/);
  });

  it("throws when blob-size is not a positive number", async () => {
    const briefcase = await fixture.createBriefcase("badsize");
    await expect(
      runPartinate({ imodelPath: briefcase.fileName, blobSize: 0 }),
    ).rejects.toThrow(/blob-size/);
  });
});

async function withReadonly<T>(
  fileName: string,
  fn: (db: BriefcaseDb) => T | Promise<T>,
): Promise<T> {
  const db = await BriefcaseDb.open({ fileName, readonly: true });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
