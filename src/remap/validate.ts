import Database from "better-sqlite3";
import type { IModelDb } from "@itwin/core-backend";
import { DbResult } from "@itwin/core-bentley";
import type { RemapProfile } from "./remap-type";
import { openReadonly } from "../host/open-imodel";
import { compareRootTiles, countDifferingTiles, formatTileComparisons, scanRootTiles } from "../tile/root-tiles";

export interface RemapCheck {
  name: string;
  passed: boolean;
  /** A failed check that is a designed consequence of the remap type, not a defect. */
  expected?: boolean;
  detail: string;
}

export interface ValidateRemapArgs {
  sourcePath: string;
  targetPath: string;
  profile: RemapProfile;
  /** Models to compare root tiles for. 0 skips the tile check. */
  tileModels: number;
}

/** Elements sampled for the geometry round trip. */
const GEOMETRY_SAMPLE = 25;

function withDb<T>(fileName: string, fn: (db: Database.Database) => T): T {
  const db = new Database(fileName, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function count(db: Database.Database, sql: string): number {
  try {
    return (db.prepare(sql).get() as { c: number }).c;
  } catch {
    return -1;
  }
}

function rowCounts(fileName: string): Record<string, number> {
  return withDb(fileName, (db) => ({
    elements: count(db, "SELECT COUNT(*) c FROM bis_Element"),
    multiAspects: count(db, "SELECT COUNT(*) c FROM bis_ElementMultiAspect"),
    uniqueAspects: count(db, "SELECT COUNT(*) c FROM bis_ElementUniqueAspect"),
    relationships: count(db, "SELECT COUNT(*) c FROM bis_ElementRefersToElements"),
    models: count(db, "SELECT COUNT(*) c FROM bis_Model"),
    geometryParts: count(
      db,
      `SELECT COUNT(*) c FROM bis_Element e JOIN ec_Class k ON k.Id=e.ECClassId
       JOIN ec_Schema s ON s.Id=k.SchemaId WHERE k.Name='GeometryPart' AND s.Name='BisCore'`,
    ),
  }));
}

function ecsqlCount(db: IModelDb, ecsql: string): number {
  return db.withPreparedStatement(ecsql, (stmt) => {
    stmt.step();
    return stmt.getValue(0).getInteger();
  });
}

/**
 * Checks run cheap to expensive; nothing downstream is meaningful if the file does not open,
 * and the tile check is minutes on a large iModel so it runs last.
 */
export async function validateRemap(args: ValidateRemapArgs): Promise<RemapCheck[]> {
  const { sourcePath, targetPath, profile } = args;
  const checks: RemapCheck[] = [];
  const add = (name: string, passed: boolean, detail: string, expected?: boolean): boolean => {
    checks.push({ name, passed, detail, expected });
    return passed;
  };

  const sourceParts = withDb(sourcePath, (db) =>
    count(
      db,
      `SELECT COUNT(*) c FROM bis_DefinitionElement d JOIN ec_Class k ON k.Id=d.ECClassId
       WHERE k.Name='GeometryPart'`,
    ),
  );

  let opened = false;
  {
    const db = openReadonly(targetPath, `validate-${process.pid}-${targetPath}`);
    try {
      const bisCore = db.withSqliteStatement(
        "SELECT VersionDigit1||'.'||VersionDigit2||'.'||VersionDigit3 FROM ec_Schema WHERE Name='BisCore'",
        (stmt) => {
          stmt.step();
          return stmt.getValue(0).getString();
        },
      );
      const parts = ecsqlCount(db, "SELECT COUNT(*) FROM BisCore.GeometryPart");
      const withGeometry = ecsqlCount(
        db,
        "SELECT COUNT(*) FROM BisCore.GeometryPart WHERE GeometryStream IS NOT NULL",
      );
      opened = add(
        "opens with iTwin.js",
        parts === sourceParts && withGeometry === parts,
        `BisCore ${bisCore}, ${parts} GeometryParts via ECSql, ${withGeometry} with geometry (source ${sourceParts})`,
      );

      // ECDb joins a class's tables with INNER JOIN and elides the join when no column from
      // the joined table is projected, so COUNT(*) alone would pass over a partly populated
      // table. Projecting a column from the new table is what makes this check real.
      let projected = 0;
      db.withPreparedStatement(
        "SELECT ECInstanceId, GeometryStream FROM BisCore.GeometryPart",
        (stmt) => {
          while (stmt.step() === DbResult.BE_SQLITE_ROW)
            projected++;
        },
      );
      add(
        "SELECT * returns every row",
        projected === sourceParts,
        `${projected} rows projected from bis.GeometryPart, expected ${sourceParts}`,
      );

      const definitionElements = ecsqlCount(db, "SELECT COUNT(*) FROM BisCore.DefinitionElement");
      const sourceDefinitionElements = await withSourceDb(sourcePath, (source) =>
        ecsqlCount(source, "SELECT COUNT(*) FROM BisCore.DefinitionElement"),
      );
      const expectedDefinitionElements = profile.keepsPolymorphicDefinitionElement
        ? sourceDefinitionElements
        : sourceDefinitionElements - sourceParts;
      add(
        "polymorphic bis.DefinitionElement",
        definitionElements === expectedDefinitionElements,
        `${sourceDefinitionElements} -> ${definitionElements}` +
          (profile.keepsPolymorphicDefinitionElement
            ? ", unchanged as designed"
            : `, short by the ${sourceParts} GeometryParts as designed`),
      );

      if (opened)
        add(...geometryRoundTrip(db, sourcePath));
    } finally {
      db.close();
    }
  }

  add(...mappingStructure(targetPath, profile));
  add(...hierarchyAndCaches(targetPath, profile));

  {
    const before = rowCounts(sourcePath);
    const after = rowCounts(targetPath);
    const differing = Object.keys(before)
      .filter((key) => before[key] !== after[key])
      .map((key) => `${key} ${before[key]}->${after[key]}`);
    add(
      "row counts identical to source",
      differing.length === 0,
      differing.length > 0
        ? differing.join(", ")
        : `${before.elements} elements, ${before.geometryParts} parts, all match`,
    );
  }

  {
    const before = withDb(sourcePath, (db) =>
      count(
        db,
        `SELECT IFNULL(SUM(LENGTH(js1)),0) c FROM bis_DefinitionElement d
         JOIN ec_Class k ON k.Id=d.ECClassId WHERE k.Name='GeometryPart'`,
      ),
    );
    const after = withDb(targetPath, (db) =>
      count(db, "SELECT IFNULL(SUM(LENGTH(GeometryStream)),0) c FROM bis_GeometryPart"),
    );
    add("geometry bytes preserved", before === after, `${before} -> ${after} bytes`);
  }

  if (args.tileModels > 0) {
    const source = await scanRootTiles(sourcePath, args.tileModels);
    const target = await scanRootTiles(targetPath, args.tileModels);
    const comparisons = await compareRootTiles(sourcePath, targetPath, source, target);
    const different = countDifferingTiles(comparisons);
    add(
      "root tiles",
      comparisons.length > 0 && different === 0,
      comparisons.length === 0 ? "no geometric models found" : `\n${formatTileComparisons(comparisons)}`,
    );
  }

  return checks;
}

async function withSourceDb<T>(fileName: string, fn: (db: IModelDb) => T): Promise<T> {
  const db = openReadonly(fileName, `validate-source-${process.pid}-${fileName}`);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Load a sample of GeometryParts through the element API and compare their geometry against
 * the source. This is the only check that catches the extended type and ExclusiveRootClassId
 * failures, both of which leave ECSql working.
 */
function geometryRoundTrip(target: IModelDb, sourcePath: string): [string, boolean, string] {
  const ids: string[] = [];
  target.withPreparedStatement(
    `SELECT ECInstanceId FROM BisCore.GeometryPart LIMIT ${GEOMETRY_SAMPLE}`,
    (stmt) => {
      while (stmt.step() === DbResult.BE_SQLITE_ROW)
        ids.push(stmt.getValue(0).getId());
    },
  );

  const source = openReadonly(sourcePath, `roundtrip-${process.pid}-${sourcePath}`);
  try {
    let matched = 0;
    let loaded = 0;
    for (const id of ids) {
      const after = target.elements.tryGetElementProps({ id, wantGeometry: true });
      const before = source.elements.tryGetElementProps({ id, wantGeometry: true });
      if (!after)
        continue;
      loaded++;
      if (JSON.stringify((after as any).geom) === JSON.stringify((before as any)?.geom))
        matched++;
    }
    return [
      "elements load with identical geometry",
      ids.length > 0 && loaded === ids.length && matched === ids.length,
      `${loaded} of ${ids.length} sampled GeometryParts load, ${matched} with geometry identical to the source`,
    ];
  } finally {
    source.close();
  }
}

function mappingStructure(targetPath: string, profile: RemapProfile): [string, boolean, string] {
  return withDb(targetPath, (db) => {
    const onNewTable = db
      .prepare(
        `SELECT pp.AccessString a FROM ec_PropertyMap pm JOIN ec_Class k ON k.Id=pm.ClassId
         JOIN ec_PropertyPath pp ON pp.Id=pm.PropertyPathId
         JOIN ec_Column c ON c.Id=pm.ColumnId JOIN ec_Table t ON t.Id=c.TableId
         WHERE k.Name='GeometryPart' AND t.Name='bis_GeometryPart'`,
      )
      .all() as { a: string }[];
    const onDefinitionElement = (
      db
        .prepare(
          `SELECT pp.AccessString a FROM ec_PropertyMap pm JOIN ec_Class k ON k.Id=pm.ClassId
           JOIN ec_PropertyPath pp ON pp.Id=pm.PropertyPathId
           JOIN ec_Column c ON c.Id=pm.ColumnId JOIN ec_Table t ON t.Id=c.TableId
           WHERE k.Name='GeometryPart' AND t.Name='bis_DefinitionElement'`,
        )
        .all() as { a: string }[]
    )
      .map((row) => row.a)
      .sort();
    const leftBehind = count(
      db,
      `SELECT IFNULL(SUM(LENGTH(js1)),0) c FROM bis_DefinitionElement d
       JOIN ec_Class k ON k.Id=d.ECClassId WHERE k.Name='GeometryPart'`,
    );

    const expected = [...profile.definitionElementMaps].sort();
    const passed =
      onNewTable.length === profile.newTableMaps &&
      onDefinitionElement.join() === expected.join() &&
      leftBehind === 0;
    return [
      "GeometryPart maps to bis_GeometryPart",
      passed,
      `${onNewTable.length} of ${profile.newTableMaps} mappings on bis_GeometryPart, [${onDefinitionElement.join(", ") || "none"}] left on ` +
        `bis_DefinitionElement (expected [${expected.join(", ") || "none"}]), ${leftBehind} geometry bytes left behind`,
    ];
  });
}

function hierarchyAndCaches(targetPath: string, profile: RemapProfile): [string, boolean, string] {
  return withDb(targetPath, (db) => {
    const baseClass = (
      db
        .prepare(
          `SELECT bc.Name n FROM ec_ClassHasBaseClasses h JOIN ec_Class c ON c.Id=h.ClassId
           JOIN ec_Class bc ON bc.Id=h.BaseClassId WHERE c.Name='GeometryPart'`,
        )
        .get() as { n: string }
    ).n;
    const ancestors = (
      db
        .prepare(
          `SELECT bc.Name n FROM ec_cache_ClassHierarchy h JOIN ec_Class c ON c.Id=h.ClassId
           JOIN ec_Class bc ON bc.Id=h.BaseClassId WHERE c.Name='GeometryPart'`,
        )
        .all() as { n: string }[]
    ).map((row) => row.n);
    const tables = (
      db
        .prepare(
          `SELECT t.Name n FROM ec_cache_ClassHasTables ct JOIN ec_Class c ON c.Id=ct.ClassId
           JOIN ec_Table t ON t.Id=ct.TableId WHERE c.Name='GeometryPart'`,
        )
        .all() as { n: string }[]
    )
      .map((row) => row.n)
      .sort();

    const expectedBase = profile.reparent ? "InformationContentElement" : "DefinitionElement";
    const expectedTables = profile.keepDefinitionRows
      ? ["bis_DefinitionElement", "bis_Element"]
      : ["bis_Element", "bis_GeometryPart"];
    const isDefinitionElement = ancestors.includes("DefinitionElement");
    const passed =
      baseClass === expectedBase &&
      tables.join() === expectedTables.join() &&
      isDefinitionElement === !profile.reparent;
    return [
      "class hierarchy and caches",
      passed,
      `base=${baseClass} (expected ${expectedBase}), tables=[${tables.join(", ")}], ` +
        `ancestry ${isDefinitionElement ? "includes" : "excludes"} DefinitionElement`,
    ];
  });
}

export function formatChecks(checks: RemapCheck[]): string {
  return checks
    .map((check) => {
      const tag = check.passed ? "PASS" : check.expected ? "note" : "FAIL";
      return `  ${tag}  ${check.name} - ${check.detail}`;
    })
    .join("\n");
}
