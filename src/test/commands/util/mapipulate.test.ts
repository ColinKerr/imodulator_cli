import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { BriefcaseDb, GeometryPart, PhysicalModel, SpatialCategory } from "@itwin/core-backend";
import {
  Code,
  GeometryStreamBuilder,
  IModel,
  SubCategoryAppearance,
  type GeometryPartProps,
  type PhysicalElementProps,
} from "@itwin/core-common";
import { Box, Range3d } from "@itwin/core-geometry";
import { runMapipulate } from "../../../commands/util/mapipulate";
import { remapOutputPath, remapProfile, REMAP_TYPES, type RemapType } from "../../../remap/remap-type";
import { HubMockFixture, type TestBriefcase } from "../../hub-mock-fixture";

const fixture = new HubMockFixture();
const outputs: string[] = [];

beforeAll(async () => {
  await fixture.startup("mapipulate");
});

afterAll(async () => {
  await fixture.shutdown();
  for (const output of outputs)
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(`${output}${suffix}`, { force: true });
});

function boxGeometry(boxCount: number): GeometryStreamBuilder {
  const builder = new GeometryStreamBuilder();
  for (let i = 0; i < boxCount; i++) {
    const box = Box.createRange(Range3d.createXYZXYZ(0, 0, i, 1, 1, i + 1), true);
    if (box)
      builder.appendGeometry(box);
  }
  return builder;
}

/** A briefcase holding `partCount` GeometryParts, each referenced by one PhysicalObject. */
async function seedBriefcase(name: string, partCount: number): Promise<TestBriefcase> {
  const briefcase = await fixture.createBriefcase(name);
  const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: false });
  try {
    const categoryId = SpatialCategory.insert(db, IModel.dictionaryId, `${name}-cat`, new SubCategoryAppearance());
    const modelId = PhysicalModel.insert(db, IModel.rootSubjectId, `${name}-model`);

    for (let i = 0; i < partCount; i++) {
      const partProps: GeometryPartProps = {
        classFullName: GeometryPart.classFullName,
        model: IModel.dictionaryId,
        code: GeometryPart.createCode(db, IModel.dictionaryId, `${name}-part-${i}`),
        geom: boxGeometry(i + 2).geometryStream,
      };
      const partId = db.elements.insertElement(partProps);

      const instance = new GeometryStreamBuilder();
      instance.appendGeometryPart3d(partId);
      const elementProps: PhysicalElementProps = {
        classFullName: "Generic:PhysicalObject",
        model: modelId,
        category: categoryId,
        code: Code.createEmpty(),
        placement: { origin: [i, 0, 0], angles: {} },
        geom: instance.geometryStream,
      };
      db.elements.insertElement(elementProps);
    }
    db.saveChanges();
  } finally {
    db.close();
  }
  return briefcase;
}

function query(fileName: string, sql: string): any {
  const db = new Database(fileName, { readonly: true });
  try {
    return db.prepare(sql).get();
  } finally {
    db.close();
  }
}

function tableExists(fileName: string, table: string): boolean {
  return query(fileName, `SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='${table}'`).c > 0;
}

async function convert(name: string, remapType: RemapType, partCount = 4) {
  const briefcase = await seedBriefcase(name, partCount);
  const output = remapOutputPath(briefcase.fileName, remapType);
  outputs.push(output);
  const result = await runMapipulate({
    imodelPath: briefcase.fileName,
    remapType,
    validate: true,
    // Tiles are covered once, by the dedicated test below; generating them for every case
    // would dominate the suite's runtime.
    tileModels: 0,
  });
  return { briefcase, output, result };
}

describe("remapOutputPath", () => {
  it("appends the remap type to the file name", () => {
    expect(remapOutputPath("/tmp/station.bim", 3001)).toBe("/tmp/station_im3001.bim");
    expect(remapOutputPath("/tmp/station_512b.bim", 3002)).toBe("/tmp/station_512b_im3002.bim");
  });

  it("handles a path with no .bim extension", () => {
    expect(remapOutputPath("/tmp/station", 3000)).toBe("/tmp/station_im3000");
  });
});

describe("remapProfile", () => {
  it("describes every remap type", () => {
    for (const type of REMAP_TYPES)
      expect(remapProfile(type).type).toBe(type);
  });

  it("rejects an unknown type", () => {
    expect(() => remapProfile(3003 as RemapType)).toThrow(/Unknown remap type/);
  });

  it("bumps both profiles together, or neither", () => {
    for (const type of REMAP_TYPES) {
      const profile = remapProfile(type);
      expect(Boolean(profile.ecDbVersion)).toBe(Boolean(profile.dgnDbVersion));
    }
  });

  it("only remap type 3000 changes the base class", () => {
    expect(remapProfile(3000).reparent).toBe(true);
    expect(remapProfile(3001).reparent).toBe(false);
    expect(remapProfile(3002).reparent).toBe(false);
  });
});

describe("imod util mapipulate", () => {
  it("leaves the source untouched and writes a new iModel", async () => {
    const { briefcase, output, result } = await convert("source-untouched", 3001);

    expect(existsSync(output)).toBe(true);
    expect(result.outputPath).toBe(output);
    // Every byte of geometry is still in the source's shared column.
    expect(tableExists(briefcase.fileName, "bis_GeometryPart")).toBe(false);
    expect(
      query(
        briefcase.fileName,
        `SELECT IFNULL(SUM(LENGTH(js1)),0) c FROM bis_DefinitionElement d
         JOIN ec_Class k ON k.Id=d.ECClassId WHERE k.Name='GeometryPart'`,
      ).c,
    ).toBe(result.geometryBytes);
  });

  it.each(REMAP_TYPES)("moves every geometry byte into bis_GeometryPart for remap type %i", async (type) => {
    const { output, result } = await convert(`move-${type}`, type);

    expect(result.parts).toBeGreaterThan(0);
    expect(result.geometryBytes).toBeGreaterThan(0);
    expect(tableExists(output, "bis_GeometryPart")).toBe(true);
    expect(query(output, "SELECT IFNULL(SUM(LENGTH(GeometryStream)),0) c FROM bis_GeometryPart").c).toBe(
      result.geometryBytes,
    );
    expect(
      query(
        output,
        `SELECT IFNULL(SUM(LENGTH(js1)),0) c FROM bis_DefinitionElement d
         JOIN ec_Class k ON k.Id=d.ECClassId WHERE k.Name='GeometryPart'`,
      ).c,
    ).toBe(0);
    expect(result.valid, JSON.stringify(result.checks, null, 2)).toBe(true);
  });

  it("keeps the stub rows and the base class for remap type 3001", async () => {
    const { output, result } = await convert("stubs-3001", 3001);

    const stubs = query(
      output,
      `SELECT COUNT(*) c FROM bis_DefinitionElement d JOIN ec_Class k ON k.Id=d.ECClassId
       WHERE k.Name='GeometryPart'`,
    ).c;
    expect(stubs).toBe(result.parts);
    expect(
      query(
        output,
        `SELECT bc.Name c FROM ec_ClassHasBaseClasses h JOIN ec_Class cl ON cl.Id=h.ClassId
         JOIN ec_Class bc ON bc.Id=h.BaseClassId WHERE cl.Name='GeometryPart'`,
      ).c,
    ).toBe("DefinitionElement");
  });

  it("deletes the rows and keeps the base class for remap type 3002", async () => {
    const { output, result } = await convert("rows-3002", 3002);

    // No GeometryPart rows are left behind in the shared table.
    expect(
      query(
        output,
        `SELECT COUNT(*) c FROM bis_DefinitionElement d JOIN ec_Class k ON k.Id=d.ECClassId
         WHERE k.Name='GeometryPart'`,
      ).c,
    ).toBe(0);
    expect(
      query(output, "SELECT COUNT(*) c FROM bis_GeometryPart").c,
    ).toBe(result.parts);

    // The schema still says a GeometryPart is a DefinitionElement, hierarchy intact.
    expect(
      query(
        output,
        `SELECT bc.Name c FROM ec_ClassHasBaseClasses h JOIN ec_Class cl ON cl.Id=h.ClassId
         JOIN ec_Class bc ON bc.Id=h.BaseClassId WHERE cl.Name='GeometryPart'`,
      ).c,
    ).toBe("DefinitionElement");
  });

  it("declares IsPrivate on GeometryPart for remap type 3002, and stores it in the new table", async () => {
    const { output } = await convert("isprivate-3002", 3002);

    // The override is what makes GeometryPart's own property map the one ECDb consults;
    // without it every query touching IsPrivate joins the table whose rows are now gone.
    expect(
      query(
        output,
        `SELECT COUNT(*) c FROM ec_Property p JOIN ec_Class cl ON cl.Id=p.ClassId
         WHERE p.Name='IsPrivate' AND cl.Name='GeometryPart'`,
      ).c,
    ).toBe(1);
    expect(
      query(
        output,
        `SELECT t.Name c FROM ec_PropertyMap pm JOIN ec_Class cl ON cl.Id=pm.ClassId
         JOIN ec_PropertyPath pp ON pp.Id=pm.PropertyPathId
         JOIN ec_Column col ON col.Id=pm.ColumnId JOIN ec_Table t ON t.Id=col.TableId
         WHERE cl.Name='GeometryPart' AND pp.AccessString='IsPrivate'`,
      ).c,
    ).toBe("bis_GeometryPart");
  });

  it("keeps GeometryPart in the hierarchy cache except under 3000", async () => {
    const ancestry = (output: string) =>
      query(
        output,
        `SELECT COUNT(*) c FROM ec_cache_ClassHierarchy h JOIN ec_Class cl ON cl.Id=h.ClassId
         JOIN ec_Class bc ON bc.Id=h.BaseClassId
         WHERE cl.Name='GeometryPart' AND bc.Name='DefinitionElement'`,
      ).c;

    // Only 3000 takes the class out of the hierarchy; 3001 and 3002 leave it intact.
    expect(ancestry((await convert("ancestry-3000", 3000)).output)).toBe(0);
    expect(ancestry((await convert("ancestry-3001", 3001)).output)).toBe(1);
    expect(ancestry((await convert("ancestry-3002", 3002)).output)).toBe(1);
  });

  it("reparents the class only for remap type 3000", async () => {
    const { output } = await convert("reparent-3000", 3000);

    expect(
      query(
        output,
        `SELECT bc.Name c FROM ec_ClassHasBaseClasses h JOIN ec_Class cl ON cl.Id=h.ClassId
         JOIN ec_Class bc ON bc.Id=h.BaseClassId WHERE cl.Name='GeometryPart'`,
      ).c,
    ).toBe("InformationContentElement");
  });

  it("marks the profile versions for 3001 and 3002 but not 3000", async () => {
    for (const type of REMAP_TYPES) {
      const { output } = await convert(`profile-${type}`, type);
      const profile = remapProfile(type);
      const stored = (namespace: string) =>
        JSON.parse(query(output, `SELECT StrData c FROM be_Prop WHERE Namespace='${namespace}' AND Name='SchemaVersion'`).c);

      if (profile.ecDbVersion) {
        expect(stored("ec_Db").sub1).toBe(type);
        expect(stored("dgn_Db").sub1).toBe(type);
      } else {
        expect(stored("ec_Db").sub1).toBe(0);
        expect(stored("dgn_Db").sub1).toBe(0);
      }
      expect(query(output, "SELECT VersionDigit3 c FROM ec_Schema WHERE Name='BisCore'").c).toBe(
        profile.bisCoreDigit3,
      );
    }
  });

  it("compares root tiles between the source and the converted iModel", async () => {
    const briefcase = await seedBriefcase("tiles", 3);
    const output = remapOutputPath(briefcase.fileName, 3001);
    outputs.push(output);

    const result = await runMapipulate({
      imodelPath: briefcase.fileName,
      remapType: 3001,
      validate: true,
      tileModels: 5,
    });

    const tiles = result.checks?.find((check) => check.name === "root tiles");
    expect(tiles, "the tile check should have run").toBeDefined();
    // A metadata only conversion preserves element ids and extents, so the generator sees
    // the same geometry and the bytes must match exactly.
    expect(tiles!.detail).toMatch(/[1-9]\d*\/\d+ byte-identical/);
    expect(tiles!.passed, tiles!.detail).toBe(true);
  });

  it("refuses to overwrite an existing conversion without --force", async () => {
    const { briefcase } = await convert("no-clobber", 3001);
    await expect(
      runMapipulate({ imodelPath: briefcase.fileName, remapType: 3001, tileModels: 0 }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses to convert an iModel that has already been converted", async () => {
    const { output } = await convert("already-converted", 3001);
    outputs.push(remapOutputPath(output, 3001));
    await expect(
      runMapipulate({ imodelPath: output, remapType: 3001, tileModels: 0 }),
    ).rejects.toThrow(/already been converted/);
  });

  it("throws when the iModel file does not exist", async () => {
    await expect(
      runMapipulate({ imodelPath: "/no/such/imodel.bim", remapType: 3001 }),
    ).rejects.toThrow(/not found/);
  });
});
