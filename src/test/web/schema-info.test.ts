import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { BriefcaseDb } from "@itwin/core-backend";
import {
  buildSchemaInfo, classesFor, loadSchemaInfo, propertiesFor, propertiesForClassName,
  type ClassRow, type PropertyRow, type SchemaInfo,
} from "../../../web/src/schema-info";
import { parseTableAliases } from "../../../web/src/table-aliases";
import { ECSQL_FUNCTIONS } from "../../../web/src/ecsql-functions";
import { closeCacheDb } from "../../cache/cache-db";
import { HubMockFixture } from "../hub-mock-fixture";
import { testCacheDir } from "../temp-workspace";

const classRows: ClassRow[] = [
  ["0x1", "BisCore", "bis", "0x42", "Element"],
  ["0x1", "BisCore", "bis", "0x43", "Model"],
  ["0x2", "Generic", "generic", "0x99", "PhysicalObject"],
];
const propertyRows: PropertyRow[] = [
  ["BisCore", "bis", "Element", "CodeValue"],
  ["BisCore", "bis", "Element", "UserLabel"],
  // Overridden properties are declared twice in a class's ancestry and arrive twice.
  ["BisCore", "bis", "Element", "CodeValue"],
  ["Generic", "generic", "PhysicalObject", "Banana"],
];

describe("buildSchemaInfo", () => {
  const info = buildSchemaInfo(classRows, propertyRows);

  it("finds classes by schema name and by alias", () => {
    expect(classesFor(info, "BisCore")).toEqual(["Element", "Model"]);
    expect(classesFor(info, "bis")).toEqual(["Element", "Model"]);
  });

  it("looks up either spelling case-insensitively, as ECSql does", () => {
    expect(classesFor(info, "biscore")).toEqual(["Element", "Model"]);
    expect(classesFor(info, "BIS")).toEqual(["Element", "Model"]);
  });

  it("lists a property once even when it is overridden in the ancestry", () => {
    expect(propertiesFor(info, "bis", "Element")).toEqual(["CodeValue", "UserLabel"]);
  });

  it("finds properties under both the schema name and the alias", () => {
    expect(propertiesFor(info, "BisCore", "Element")).toEqual(["CodeValue", "UserLabel"]);
    expect(propertiesFor(info, "bis", "Element")).toEqual(["CodeValue", "UserLabel"]);
    expect(propertiesFor(info, "BIS", "element")).toEqual(["CodeValue", "UserLabel"]);
  });

  it("finds properties of a bare class name whatever schema it is in", () => {
    expect(propertiesForClassName(info, "PhysicalObject")).toEqual(["Banana"]);
  });

  it("reports each schema once, with its alias", () => {
    expect(info.schemas).toEqual([
      { name: "BisCore", alias: "bis" },
      { name: "Generic", alias: "generic" },
    ]);
  });

  it("keeps the canonical schema name for annotating class ids", () => {
    // The results table shows one name, never the alias.
    expect(info.classNamesById.get("0x42")).toBe("BisCore.Element");
  });

  it("returns nothing for a prefix it does not know", () => {
    expect(classesFor(info, "nosuch")).toEqual([]);
    expect(propertiesFor(info, "bis", "NoSuchClass")).toEqual([]);
  });
});

describe("parseTableAliases", () => {
  const alias = (sql: string, name: string) => parseTableAliases(sql).get(name);

  it("binds an alias written with AS and without", () => {
    expect(alias("SELECT * FROM bis.Element e", "e")).toEqual({ prefix: "bis", className: "Element", alias: "e" });
    expect(alias("SELECT * FROM bis.Element AS el", "el")).toEqual({ prefix: "bis", className: "Element", alias: "el" });
  });

  it("does not mistake a following keyword for an alias", () => {
    expect(parseTableAliases("SELECT * FROM bis.Element WHERE x=1").size).toBe(0);
    expect(parseTableAliases("SELECT * FROM bis.Element ORDER BY x").size).toBe(0);
    expect(parseTableAliases("SELECT * FROM bis.Element LIMIT 10").size).toBe(0);
  });

  it("binds every source in a join", () => {
    const aliases = parseTableAliases("SELECT * FROM bis.Element e INNER JOIN bis.Model m ON e.Model.Id = m.ECInstanceId");
    expect(aliases.get("e")?.className).toBe("Element");
    expect(aliases.get("m")?.className).toBe("Model");
  });

  it("reads ONLY, brackets and the colon spelling", () => {
    expect(alias("SELECT * FROM ONLY bis.Element e", "e")?.className).toBe("Element");
    expect(alias("SELECT * FROM [BisCore].[Element] e", "e")?.prefix).toBe("BisCore");
    expect(alias("SELECT * FROM BisCore:Element e", "e")?.className).toBe("Element");
  });

  it("is case-insensitive about the alias and the keywords", () => {
    expect(alias("select * from bis.Element E", "e")?.alias).toBe("E");
  });

  it("lets a later binding of the same alias win", () => {
    expect(alias("SELECT * FROM bis.Element e, bis.Model e", "e")?.className).toBe("Model");
  });

  it("finds nothing in a query with no FROM clause", () => {
    expect(parseTableAliases("PRAGMA ecdb_ver").size).toBe(0);
  });
});

describe("ECSQL_FUNCTIONS", () => {
  it("lists the ECSql built-ins with unique names and a snippet each", () => {
    expect(ECSQL_FUNCTIONS.map((f) => f.name)).toEqual([
      "ec_classname", "ec_classId", "REGEXP", "REGEXP_EXTRACT",
      "StrToGuid", "GuidToStr", "NAVIGATION_VALUE", "supports_instance_query",
    ]);
    for (const fn of ECSQL_FUNCTIONS) {
      expect(fn.snippet.startsWith(`${fn.name}(`), fn.name).toBe(true);
      expect(fn.signature).toContain(fn.name);
    }
  });
});

describe("loadSchemaInfo against a real iModel", () => {
  const fixture = new HubMockFixture();
  let cacheDir: string;
  let info: SchemaInfo;

  beforeAll(async () => {
    cacheDir = testCacheDir();
    await fixture.startup("schema-info");
    const briefcase = await fixture.createBriefcase("schemas");
    const db = await BriefcaseDb.open({ fileName: briefcase.fileName, readonly: true });
    try {
      // A backend iModel drives the same createQueryReader the frontend uses.
      info = await loadSchemaInfo(db);
    } finally {
      db.close();
    }
  });

  afterAll(async () => {
    closeCacheDb();
    await fixture.shutdown();
  });

  it("resolves BisCore's classes by name and by its real alias", () => {
    const byName = classesFor(info, "BisCore");
    const byAlias = classesFor(info, "bis");
    expect(byName).toContain("Element");
    // The alias is read from the iModel, not assumed.
    expect(byAlias).toEqual(byName);
  });

  it("resolves properties through either spelling", () => {
    expect(propertiesFor(info, "BisCore", "Element")).toContain("CodeValue");
    expect(propertiesFor(info, "bis", "Element")).toContain("CodeValue");
  });

  it("includes inherited properties, which is all most concrete classes have", () => {
    // Generic.PhysicalObject declares none of its own; everything comes from its ancestry.
    const properties = propertiesFor(info, "generic", "PhysicalObject");
    expect(properties).toContain("CodeValue");     // from bis.Element
    expect(properties).toContain("GeometryStream"); // from bis.GeometricElement3d
    expect(properties).toContain("Category");       // from bis.GeometricElement3d
    expect(new Set(properties).size).toBe(properties.length);
  });

  it("records every schema with an alias", () => {
    expect(info.schemas.length).toBeGreaterThan(1);
    expect(info.schemas.find((s) => s.name === "BisCore")?.alias).toBe("bis");
  });
});
