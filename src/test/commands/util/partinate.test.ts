import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BriefcaseDb,
  PhysicalModel,
  SpatialCategory,
  SubCategory,
} from "@itwin/core-backend";
import { DbResult, Id64, IModelStatus, type Id64String } from "@itwin/core-bentley";
import {
  Code,
  ColorDef,
  ElementGeometry,
  ElementGeometryOpcode,
  GeometryParams,
  GeometryStreamBuilder,
  IModel,
  SubCategoryAppearance,
  type ElementGeometryDataEntry,
  type ElementGeometryInfo,
  type GeometryStreamProps,
  type PhysicalElementProps,
} from "@itwin/core-common";
import { Box, Range3d } from "@itwin/core-geometry";
import { prepareForPart, runPartinate } from "../../../commands/util/partinate";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();

beforeAll(async () => {
  await fixture.startup("partinate");
});

afterAll(async () => {
  await fixture.shutdown();
});

/** Append `boxCount` stacked boxes, used to inflate the stored blob past the threshold. */
function appendBoxes(builder: GeometryStreamBuilder, boxCount: number): GeometryStreamBuilder {
  for (let i = 0; i < boxCount; i++) {
    const box = Box.createRange(Range3d.createXYZXYZ(0, 0, i, 1, 1, i + 1), true);
    if (box)
      builder.appendGeometry(box);
  }
  return builder;
}

/** A geometry stream of `boxCount` stacked boxes, used to inflate the stored blob. */
function buildBoxGeometry(boxCount: number): GeometryStreamProps {
  return appendBoxes(new GeometryStreamBuilder(), boxCount).geometryStream;
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

/** The stored flatbuffer entries of an element or part, as the command itself reads them. */
function geometryEntries(db: BriefcaseDb, elementId: string): ElementGeometryDataEntry[] {
  let info: ElementGeometryInfo | undefined;
  const status = db.elementGeometryRequest({
    elementId,
    onGeometry: (geometry) => { info = geometry; },
  });
  expect(status).toBe(IModelStatus.Success);
  expect(info).toBeDefined();
  return info!.entryArray;
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

interface SeedContext {
  db: BriefcaseDb;
  modelId: string;
  categoryId: string;
  name: string;
}

/**
 * Seed a briefcase holding a single over-threshold element whose geometry stream is
 * built by `build`, and return a `blobSize` that makes that element a candidate.
 */
async function seedElement(
  name: string,
  build: (ctx: SeedContext) => GeometryStreamProps,
): Promise<{ briefcase: TestBriefcase; elementId: string; blobSize: number }> {
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
    const geom = build({ db, modelId, categoryId, name });
    const elementId = insertPhysicalObject(db, modelId, categoryId, geom);
    db.saveChanges();
    const blobLength = geometryBlobLength(db, elementId);
    return { briefcase, elementId, blobSize: Math.floor(blobLength / 2) };
  } finally {
    db.close();
  }
}

/** Assert that partinate leaves the seeded element and the GeometryPart count alone. */
async function expectSkipped(
  briefcase: TestBriefcase,
  elementId: string,
  blobSize: number,
): Promise<void> {
  const before = await withReadonly(briefcase.fileName, async (db) => ({
    parts: await countGeometryParts(db),
    geom: JSON.stringify(
      db.elements.getElementProps<PhysicalElementProps>({ id: elementId, wantGeometry: true }).geom,
    ),
  }));

  const result = await runPartinate({ imodelPath: briefcase.fileName, blobSize });

  expect(result.converted).toBe(0);
  expect(result.partsCreated).toBe(0);
  expect(result.skipped).toBeGreaterThanOrEqual(1);

  await withReadonly(briefcase.fileName, async (db) => {
    expect(await countGeometryParts(db)).toBe(before.parts);
    const geom = db.elements.getElementProps<PhysicalElementProps>({
      id: elementId,
      wantGeometry: true,
    }).geom;
    expect(JSON.stringify(geom)).toBe(before.geom);
  });
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

  it("copies the stored geometry entries into the part byte for byte", async () => {
    const { briefcase, bigId, smallLen, bigLen } = await seedBriefcase("verbatim");
    const blobSize = Math.floor((smallLen + bigLen) / 2);

    const before = await withReadonly(briefcase.fileName, (db) => geometryEntries(db, bigId));
    // Only sub-graphic ranges are dropped; everything else must survive untouched.
    const expected = before.filter((e) => e.opcode !== ElementGeometryOpcode.SubGraphicRange);
    expect(expected.length).toBeGreaterThan(0);

    const result = await runPartinate({ imodelPath: briefcase.fileName, blobSize });
    expect(result.converted).toBe(1);

    await withReadonly(briefcase.fileName, (db) => {
      const elementEntries = geometryEntries(db, bigId);
      expect(elementEntries).toHaveLength(1);
      expect(elementEntries[0].opcode).toBe(ElementGeometryOpcode.PartReference);

      const partId = ElementGeometry.toGeometryPart(elementEntries[0]);
      expect(partId).toBeDefined();

      const partEntries = geometryEntries(db, partId!);
      expect(partEntries.map((e) => e.opcode)).toEqual(expected.map((e) => e.opcode));
      for (let i = 0; i < expected.length; i++)
        expect(Buffer.from(partEntries[i].data)).toEqual(Buffer.from(expected[i].data));
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

/**
 * A GeometryPart's geometry stream may not contain everything a GeometricElement's may:
 * nested part references and sub-category changes are invalid, and the appearance a part
 * uses is inherited from the element that instances it. Wholesale-moving such a stream
 * into a part either fails the insert (BadElement) or silently changes how the element
 * draws, so those elements must be left alone.
 */
describe("imod util partinate skip conditions", () => {
  it("skips an element whose stream references a GeometryPart (parts cannot nest)", async () => {
    const { briefcase, elementId, blobSize } = await seedElement("skip-part-ref", ({ db }) => {
      const partId = db.elements.insertElement({
        classFullName: "BisCore:GeometryPart",
        model: IModel.dictionaryId,
        code: Code.createEmpty(),
        geom: buildBoxGeometry(1),
      });
      const builder = new GeometryStreamBuilder();
      builder.appendGeometryPart3d(partId);
      return appendBoxes(builder, 1000).geometryStream;
    });

    await expectSkipped(briefcase, elementId, blobSize);
  });

  it("skips an element whose stream changes sub-category", async () => {
    const { briefcase, elementId, blobSize } = await seedElement(
      "skip-subcategory",
      ({ db, categoryId, name }) => {
        const subCategoryId = SubCategory.insert(
          db,
          categoryId,
          `${name}-sub`,
          new SubCategoryAppearance({ color: ColorDef.blue.toJSON() }),
        );
        const builder = new GeometryStreamBuilder();
        appendBoxes(builder, 500);
        builder.appendSubCategoryChange(subCategoryId);
        return appendBoxes(builder, 500).geometryStream;
      },
    );

    await expectSkipped(briefcase, elementId, blobSize);
  });

  it("skips an element whose stream carries a view-independent header flag", async () => {
    const { briefcase, elementId, blobSize } = await seedElement("skip-view-independent", () => {
      const builder = new GeometryStreamBuilder();
      builder.isViewIndependent = true;
      return appendBoxes(builder, 1000).geometryStream;
    });

    await expectSkipped(briefcase, elementId, blobSize);
  });

  it("converts an element that only overrides appearance, without a sub-category change", async () => {
    // A pure symbology override survives the move into a part, so it must NOT be skipped.
    const { briefcase, elementId, blobSize } = await seedElement("keep-appearance", () => {
      const builder = new GeometryStreamBuilder();
      appendBoxes(builder, 500);
      builder.geometryStream.push({ appearance: { color: ColorDef.red.toJSON(), weight: 3 } });
      return appendBoxes(builder, 500).geometryStream;
    });

    const result = await runPartinate({ imodelPath: briefcase.fileName, blobSize });

    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(0);
    await withReadonly(briefcase.fileName, async (db) => {
      const props = db.elements.getElementProps<PhysicalElementProps>({
        id: elementId,
        wantGeometry: true,
      });
      const refs = geometryPartReferences(props.geom);
      expect(refs).toHaveLength(1);
      // The colour override must still be there, inside the part.
      const part = db.elements.getElementProps({ id: refs[0], wantGeometry: true }) as {
        geom?: GeometryStreamProps;
      };
      const appearances = (part.geom ?? []).filter((entry) => entry.appearance !== undefined);
      expect(appearances).toHaveLength(1);
      expect(appearances[0].appearance).toMatchObject({ color: ColorDef.red.toJSON(), weight: 3 });
    });
  });

  it("converts an element whose stream only stores per-geometry sub-ranges", async () => {
    // subRange entries are a range-testing hint that a part ignores; dropping them changes
    // nothing about how the element draws, so these elements are still worth converting.
    const { briefcase, blobSize } = await seedElement("keep-sub-range", () => {
      const builder = new GeometryStreamBuilder();
      builder.appendGeometryRanges();
      return appendBoxes(builder, 1000).geometryStream;
    });

    const result = await runPartinate({ imodelPath: briefcase.fileName, blobSize });

    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

/**
 * `prepareForPart` works on the stored flatbuffer entries, so these build entry arrays
 * rather than JSON geometry streams.
 *
 * Note what is *not* here: a stream holding a NaN coordinate, or a geometry entry that
 * holds no geometry (`{ path: [] }`). Both exist in real iModels written by other tooling
 * -- both turned up in 02_TSDU.bim and both fail the part insert with `BadElement` -- but
 * spotting them would mean decoding the geometry, which is exactly what this command must
 * not do. They are caught by the insert and skipped as `geometryIncompatibleWithPart`.
 */
describe("prepareForPart", () => {
  const CATEGORY_ID = "0x30";
  const DEFAULT_SUBCATEGORY_ID = "0x31"; // IModelDb.getDefaultSubCategoryId(CATEGORY_ID)

  /** The skip reason, or undefined when the stream can be converted. */
  function skipReason(info: ElementGeometryInfo): string | undefined {
    const prepared = prepareForPart(info);
    return "skip" in prepared ? prepared.skip : undefined;
  }

  /** The entries that would be stored in the part; fails if the stream is skipped. */
  function preparedEntries(info: ElementGeometryInfo): ElementGeometryDataEntry[] {
    const prepared = prepareForPart(info);
    if ("skip" in prepared)
      throw new Error(`expected conversion, got skip: ${prepared.skip}`);
    return prepared.entryArray;
  }

  function entriesOf(build: (builder: ElementGeometry.Builder) => void): ElementGeometryDataEntry[] {
    const builder = new ElementGeometry.Builder();
    build(builder);
    return builder.entries;
  }

  function infoOf(
    entryArray: ElementGeometryDataEntry[],
    extra: Partial<ElementGeometryInfo> = {},
  ): ElementGeometryInfo {
    return { categoryId: CATEGORY_ID, entryArray, ...extra };
  }

  function appendBox(builder: ElementGeometry.Builder): void {
    const box = Box.createRange(Range3d.createXYZXYZ(0, 0, 0, 1, 1, 1), true);
    expect(box).toBeDefined();
    expect(builder.appendGeometryQuery(box!)).toBe(true);
  }

  function symbology(subCategoryId: Id64String): ElementGeometryDataEntry[] {
    const params = new GeometryParams(CATEGORY_ID, subCategoryId);
    params.weight = 3;
    const entries: ElementGeometryDataEntry[] = [];
    expect(ElementGeometry.appendGeometryParams(params, entries)).toBe(true);
    return entries;
  }

  it("rejects a stream containing a part reference", () => {
    expect(skipReason(infoOf(entriesOf((b) => {
      appendBox(b);
      expect(b.appendGeometryPart("0x2a")).toBe(true);
    })))).toBe("partReference");
  });

  it("rejects a stream that puts geometry on another sub-category", () => {
    expect(skipReason(infoOf([
      ...symbology("0x99"),
      ...entriesOf(appendBox),
    ]))).toBe("subCategoryChange");
  });

  it("accepts symbology naming the element's own default sub-category", () => {
    // The stored stream routinely names the default sub-category explicitly; that carries
    // no information a part would lose, so it must not be treated as a change.
    expect(skipReason(infoOf([
      ...symbology(DEFAULT_SUBCATEGORY_ID),
      ...entriesOf(appendBox),
    ]))).toBeUndefined();
  });

  it("rejects a view-independent stream", () => {
    expect(skipReason(infoOf(entriesOf(appendBox), { viewIndependent: true })))
      .toBe("streamFlags");
  });

  it("rejects a stream with no geometry entries at all", () => {
    expect(skipReason(infoOf(symbology(DEFAULT_SUBCATEGORY_ID)))).toBe("noGeometry");
    expect(skipReason(infoOf([]))).toBe("noGeometry");
  });

  it("accepts a plain geometry stream", () => {
    expect(skipReason(infoOf(entriesOf((b) => {
      appendBox(b);
      appendBox(b);
    })))).toBeUndefined();
  });

  it("accepts a stream carrying sub-graphic ranges, and drops them from the part", () => {
    const info = infoOf(entriesOf((b) => {
      expect(b.appendGeometryRanges()).toBe(true);
      appendBox(b);
    }));
    expect(info.entryArray.some((e) => e.opcode === ElementGeometryOpcode.SubGraphicRange)).toBe(true);

    const entries = preparedEntries(info);
    expect(entries.some((e) => e.opcode === ElementGeometryOpcode.SubGraphicRange)).toBe(false);
    expect(entries.some((e) => ElementGeometry.isGeometricEntry(e))).toBe(true);
  });

  /**
   * A symbology entry that sets nothing means "drop all overrides, go back to the
   * sub-category appearance". The backend rejects it inside a part -- it was 104 of 104
   * failures in a sample of 02_TSDU.bim -- so it is dropped where it says nothing and
   * skipped where it does.
   */
  describe("appearance resets", () => {
    const reset = (): ElementGeometryDataEntry[] => {
      const entries: ElementGeometryDataEntry[] = [];
      expect(ElementGeometry.appendGeometryParams(new GeometryParams(Id64.invalid), entries)).toBe(true);
      return entries;
    };

    it("drops a leading reset, which cannot change any appearance", () => {
      const info = infoOf([...reset(), ...entriesOf(appendBox)]);
      const entries = preparedEntries(info);
      expect(entries.some((e) => e.opcode === ElementGeometryOpcode.BasicSymbology)).toBe(false);
      expect(entries).toHaveLength(1);
    });

    it("keeps symbology that actually sets something", () => {
      const entries = preparedEntries(infoOf([
        ...symbology(DEFAULT_SUBCATEGORY_ID),
        ...entriesOf(appendBox),
      ]));
      expect(entries.some((e) => e.opcode === ElementGeometryOpcode.BasicSymbology)).toBe(true);
    });

    it("skips a reset that follows an override, whose meaning a part cannot reproduce", () => {
      expect(skipReason(infoOf([
        ...symbology(DEFAULT_SUBCATEGORY_ID),
        ...entriesOf(appendBox),
        ...reset(),
        ...entriesOf(appendBox),
      ]))).toBe("appearanceReset");
    });
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
