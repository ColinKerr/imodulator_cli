import type { Database } from "better-sqlite3";
import type { RemapProfile } from "./remap-type";
import { MapipulateResult } from "../commands/util/mapipulate";

/** Ids the mapipulate SQL needs. They are file specific and must never be hard coded. */
export interface RemapIds {
  geometryPart: number;
  definitionElement: number;
  informationContentElement: number;
  elementTable: number;
  definitionElementTable: number;
}

/** The seven GeometryPart properties that carry geometry, and the columns they move to. */
const GEOMETRY_PROPERTIES: readonly (readonly [string, string])[] = [
  ["GeometryStream", "GeometryStream"],
  ["BBoxLow.X", "BBoxLow_X"],
  ["BBoxLow.Y", "BBoxLow_Y"],
  ["BBoxLow.Z", "BBoxLow_Z"],
  ["BBoxHigh.X", "BBoxHigh_X"],
  ["BBoxHigh.Y", "BBoxHigh_Y"],
  ["BBoxHigh.Z", "BBoxHigh_Z"],
];

const BBOX_COLUMNS = ["BBoxLow_X", "BBoxLow_Y", "BBoxLow_Z", "BBoxHigh_X", "BBoxHigh_Y", "BBoxHigh_Z"];

/**
 * The extended types SchemaReader patches into the ECDbSystem schema at load time, but only
 * for files below ec_Db 4.0.0.3. Past that the patch stops firing and element loading fails
 * while ECSql keeps working, so any profile bump must write them to disk first.
 */
const SYSTEM_EXTENDED_TYPES: Record<string, Record<string, string>> = {
  ClassECSqlSystemProperties: { ECInstanceId: "Id", ECClassId: "ClassId" },
  RelationshipECSqlSystemProperties: {
    SourceECInstanceId: "SourceId",
    SourceECClassId: "SourceClassId",
    TargetECInstanceId: "TargetId",
    TargetECClassId: "TargetClassId",
  },
  NavigationECSqlSystemProperties: { Id: "NavId", RelECClassId: "NavRelClassId" },
};

export function resolveIds(db: Database): RemapIds {
  const classId = (name: string): number => {
    const row = db
      .prepare(
        "SELECT Id FROM ec_Class WHERE Name=? AND SchemaId=(SELECT Id FROM ec_Schema WHERE Name='BisCore')",
      )
      .get(name) as { Id: number } | undefined;
    if (!row)
      throw new Error(`Class not found: ${name}`);
    return row.Id;
  };
  const tableId = (name: string): number => {
    const row = db.prepare("SELECT Id FROM ec_Table WHERE Name=?").get(name) as { Id: number } | undefined;
    if (!row)
      throw new Error(`Table not found: ${name}`);
    return row.Id;
  };
  return {
    geometryPart: classId("GeometryPart"),
    definitionElement: classId("DefinitionElement"),
    informationContentElement: classId("InformationContentElement"),
    elementTable: tableId("bis_Element"),
    definitionElementTable: tableId("bis_DefinitionElement"),
  };
}

export interface GeometryPartTotals {
  rows: number;
  bytes: number;
}

/** GeometryPart rows and geometry bytes still in bis_DefinitionElement. */
export function countGeometryParts(db: Database, ids: RemapIds): GeometryPartTotals {
  const row = db
    .prepare("SELECT COUNT(*) n, IFNULL(SUM(LENGTH(js1)),0) b FROM bis_DefinitionElement WHERE ECClassId=?")
    .get(ids.geometryPart) as { n: number; b: number };
  return { rows: row.n, bytes: row.b };
}

export function geometryPartTableExists(db: Database): boolean {
  return (
    db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='bis_GeometryPart'").get() as {
      n: number;
    }
  ).n > 0;
}

export interface GeometryPartTable {
  tableId: number;
  columnId: (name: string) => number;
}

/**
 * The physical table and the ec_Table / ec_Column / ec_Index metadata describing it.
 *
 * ExclusiveRootClassId must not be NULL: left unset the addon segfaults during element
 * loading as soon as a property map points here, while plain ECSql keeps working.
 */
export function createGeometryPartTable(
  db: Database,
  ids: RemapIds,
  parentTableId: number,
  withIsPrivate: boolean,
): GeometryPartTable {
  db.exec(`CREATE TABLE [bis_GeometryPart](
    [ElementId] INTEGER PRIMARY KEY, [ECClassId] INTEGER NOT NULL,
    [GeometryStream] BLOB,
    [BBoxLow_X] REAL, [BBoxLow_Y] REAL, [BBoxLow_Z] REAL,
    [BBoxHigh_X] REAL, [BBoxHigh_Y] REAL, [BBoxHigh_Z] REAL${withIsPrivate ? ", [IsPrivate] BOOLEAN" : ""},
    FOREIGN KEY([ElementId]) REFERENCES [bis_Element]([Id]) ON DELETE CASCADE);
    CREATE INDEX [ix_bis_GeometryPart_ecclassid] ON [bis_GeometryPart]([ECClassId]);`);

  db.prepare(
    `INSERT INTO ec_Table (ParentTableId, Name, Type, ExclusiveRootClassId, UpdatableViewName)
     VALUES (?, 'bis_GeometryPart', 1, ?, NULL)`,
  ).run(parentTableId, ids.geometryPart);
  const tableId = (db.prepare("SELECT Id FROM ec_Table WHERE Name='bis_GeometryPart'").get() as { Id: number }).Id;

  // Type 2=blob 4=real 5=integer; ColumnKind 0=data 1=id 2=classid. UniqueConstraint and
  // CollationConstraint are NOT NULL; OrdinalInPrimaryKey is 0 for the primary key only.
  const column = db.prepare(
    `INSERT INTO ec_Column
     (TableId, Name, Type, IsVirtual, Ordinal, NotNullConstraint, UniqueConstraint,
      CheckConstraint, DefaultConstraint, CollationConstraint, OrdinalInPrimaryKey, ColumnKind)
     VALUES (?,?,?,0,?,?,0,NULL,NULL,0,?,?)`,
  );
  column.run(tableId, "ElementId", 5, 0, 0, 0, 1);
  column.run(tableId, "ECClassId", 5, 1, 1, null, 2);
  column.run(tableId, "GeometryStream", 2, 2, 0, null, 0);
  BBOX_COLUMNS.forEach((name, i) => column.run(tableId, name, 4, 3 + i, 0, null, 0));
  // ec_Column.Type 1 is boolean, matching bis_DefinitionElement.IsPrivate.
  if (withIsPrivate)
    column.run(tableId, "IsPrivate", 1, 3 + BBOX_COLUMNS.length, 0, null, 0);

  const columnId = (name: string): number =>
    (db.prepare("SELECT Id FROM ec_Column WHERE TableId=? AND Name=?").get(tableId, name) as { Id: number }).Id;

  db.prepare(
    `INSERT INTO ec_Index (Name, TableId, IsUnique, AddNotNullWhereExp, IsAutoGenerated, ClassId, AppliesToSubclassesIfPartial)
     VALUES ('ix_bis_GeometryPart_ecclassid', ?, 0, 0, 1, NULL, 1)`,
  ).run(tableId);
  const indexId = (
    db.prepare("SELECT Id FROM ec_Index WHERE Name='ix_bis_GeometryPart_ecclassid'").get() as { Id: number }
  ).Id;
  db.prepare("INSERT INTO ec_IndexColumn (IndexId, ColumnId, Ordinal) VALUES (?,?,0)").run(
    indexId,
    columnId("ECClassId"),
  );

  return { tableId, columnId };
}

function propertyPathId(db: Database, ids: RemapIds, accessString: string): number {
  const row = db
    .prepare(
      `SELECT pp.Id FROM ec_PropertyMap pm JOIN ec_PropertyPath pp ON pp.Id=pm.PropertyPathId
       WHERE pm.ClassId=? AND pp.AccessString=?`,
    )
    .get(ids.geometryPart, accessString) as { Id: number } | undefined;
  if (!row)
    throw new Error(`No property map for GeometryPart.${accessString}`);
  return row.Id;
}

/** Point the seven geometry properties at the new table. Common to every remap type. */
export function repointGeometryProperties(db: Database, ids: RemapIds, table: GeometryPartTable): void {
  const repoint = db.prepare("UPDATE ec_PropertyMap SET ColumnId=? WHERE ClassId=? AND PropertyPathId=?");
  for (const [accessString, column] of GEOMETRY_PROPERTIES)
    repoint.run(table.columnId(column), ids.geometryPart, propertyPathId(db, ids, accessString));
}

/**
 * Give GeometryPart a third ECInstanceId / ECClassId pair on the new table, making it a
 * three level joined class. ECDb maps one pair per table in a joined class's chain.
 */
export function addJoinedTableSystemMaps(db: Database, ids: RemapIds, table: GeometryPartTable): void {
  const add = db.prepare("INSERT INTO ec_PropertyMap (ClassId, PropertyPathId, ColumnId) VALUES (?,?,?)");
  add.run(ids.geometryPart, propertyPathId(db, ids, "ECInstanceId"), table.columnId("ElementId"));
  add.run(ids.geometryPart, propertyPathId(db, ids, "ECClassId"), table.columnId("ECClassId"));
}

/**
 * Move the identity columns to the new table and drop everything GeometryPart still had on
 * bis_DefinitionElement, so its chain runs bis_Element -> bis_GeometryPart.
 *
 * IsPrivate is the one property that stands in the way. While GeometryPart is still a
 * DefinitionElement it inherits that property, and ECDb resolves an inherited property
 * through the class that declares it, so every query touching IsPrivate joins
 * bis_DefinitionElement whatever GeometryPart's own map says -- and with the rows deleted
 * that join finds nothing and no part can be loaded. Two ways out, one per remap type:
 * reparenting removes the property from the class, and a schema override makes GeometryPart
 * the declaring class so its map becomes the one ECDb reads.
 */
export function severFromDefinitionElement(
  db: Database,
  ids: RemapIds,
  table: GeometryPartTable,
  moveIsPrivate: boolean,
): number {
  const system = db.prepare(
    `UPDATE ec_PropertyMap SET ColumnId=? WHERE ClassId=? AND PropertyPathId=?
     AND ColumnId IN (SELECT Id FROM ec_Column WHERE TableId=?)`,
  );
  system.run(table.columnId("ElementId"), ids.geometryPart, propertyPathId(db, ids, "ECInstanceId"), ids.definitionElementTable);
  system.run(table.columnId("ECClassId"), ids.geometryPart, propertyPathId(db, ids, "ECClassId"), ids.definitionElementTable);

  const isPrivatePath = propertyPathId(db, ids, "IsPrivate");
  if (moveIsPrivate)
    db.prepare("UPDATE ec_PropertyMap SET ColumnId=? WHERE ClassId=? AND PropertyPathId=?").run(
      table.columnId("IsPrivate"),
      ids.geometryPart,
      isPrivatePath,
    );
  else
    db.prepare("DELETE FROM ec_PropertyMap WHERE ClassId=? AND PropertyPathId=?").run(ids.geometryPart, isPrivatePath);
  const strays = db
    .prepare(
      `DELETE FROM ec_PropertyMap WHERE ClassId=?
       AND ColumnId IN (SELECT Id FROM ec_Column WHERE TableId=?)`,
    )
    .run(ids.geometryPart, ids.definitionElementTable);

  db.prepare(
    "UPDATE ec_ClassMap SET ShareColumnsMode=NULL, MaxSharedColumnsBeforeOverflow=NULL WHERE ClassId=?",
  ).run(ids.geometryPart);

  return strays.changes;
}

/** Reparent GeometryPart to InformationContentElement, in the schema and the hierarchy cache. */
export function reparentGeometryPart(db: Database, ids: RemapIds): void {
  db.prepare("UPDATE ec_ClassHasBaseClasses SET BaseClassId=? WHERE ClassId=? AND BaseClassId=?").run(
    ids.informationContentElement,
    ids.geometryPart,
    ids.definitionElement,
  );
  db.prepare("DELETE FROM ec_cache_ClassHierarchy WHERE ClassId=? AND BaseClassId=?").run(
    ids.geometryPart,
    ids.definitionElement,
  );
}

/**
 * Replace GeometryPart's bis_DefinitionElement entry with the new table.
 *
 * Only for the variants that sever the chain. Adding a row instead of replacing one makes
 * ECDb treat the new table as a second root and emit every GeometryPart query as a two arm
 * UNION that reads all three tables twice.
 */
export function retargetClassHasTables(db: Database, ids: RemapIds, tableId: number): void {
  db.prepare("UPDATE ec_cache_ClassHasTables SET TableId=? WHERE ClassId=? AND TableId=?").run(
    tableId,
    ids.geometryPart,
    ids.definitionElementTable,
  );
}

export function setBisCoreVersion(db: Database, digit3: number): void {
  db.prepare("UPDATE ec_Schema SET VersionDigit3=? WHERE Name='BisCore'").run(digit3);
}

/**
 * Set a be_Prop profile version.
 *
 * The three profiles must never end up mixed old and new relative to the reading software:
 * ProfileState::Merge has no representation for "one newer, another older" and collapses the
 * file to BE_SQLITE_ERROR_InvalidProfileVersion. Bump ec_Db and dgn_Db together or not at all.
 */
export function setProfileVersion(
  db: Database,
  namespace: string,
  [major, minor, sub1, sub2]: readonly [number, number, number, number],
): void {
  const result = db
    .prepare("UPDATE be_Prop SET StrData=? WHERE Namespace=? AND Name='SchemaVersion'")
    .run(JSON.stringify({ major, minor, sub1, sub2 }), namespace);
  if (result.changes !== 1)
    throw new Error(`Expected 1 ${namespace} SchemaVersion row, updated ${result.changes}.`);
}

/**
 * Write the ECDbSystem extended types to disk. Mandatory before any ec_Db bump past 4.0.0.3.
 * Reports rows actually corrected, so on an already upgraded file this returns 0 and stands
 * as an assertion.
 */
export function patchSystemExtendedTypes(db: Database): number {
  const update = db.prepare(
    `UPDATE ec_Property SET ExtendedTypeName=?
     WHERE Name=? AND ExtendedTypeName IS NOT ?
       AND ClassId=(SELECT c.Id FROM ec_Class c JOIN ec_Schema s ON s.Id=c.SchemaId
                    WHERE s.Name='ECDbSystem' AND c.Name=?)`,
  );
  let changed = 0;
  for (const [className, properties] of Object.entries(SYSTEM_EXTENDED_TYPES))
    for (const [property, extendedType] of Object.entries(properties))
      changed += update.run(extendedType, property, extendedType, className).changes;
  return changed;
}

/**
 * Copy the rows across, verify counts and bytes before destroying anything, then clear the
 * originals.
 */
export function migrateGeometryPartData(
  db: Database,
  ids: RemapIds,
  before: GeometryPartTotals,
  keepDefinitionRows: boolean,
  withIsPrivate: boolean,
): void {
  db.prepare(
    `INSERT INTO bis_GeometryPart
     (ElementId, ECClassId, GeometryStream, BBoxLow_X, BBoxLow_Y, BBoxLow_Z, BBoxHigh_X, BBoxHigh_Y, BBoxHigh_Z${withIsPrivate ? ", IsPrivate" : ""})
     SELECT d.ElementId, d.ECClassId, d.js1, d.js2, d.js3, d.js4, d.js5, d.js6, d.js7${withIsPrivate ? ", d.IsPrivate" : ""}
     FROM bis_DefinitionElement d WHERE d.ECClassId=?`,
  ).run(ids.geometryPart);

  const moved = db
    .prepare("SELECT COUNT(*) n, IFNULL(SUM(LENGTH(GeometryStream)),0) b FROM bis_GeometryPart")
    .get() as { n: number; b: number };
  if (moved.n !== before.rows || moved.b !== before.bytes)
    throw new Error(
      `Migration mismatch: moved ${moved.n} rows / ${moved.b} bytes, expected ${before.rows} / ${before.bytes}.`,
    );

  if (keepDefinitionRows) {
    db.prepare(
      `UPDATE bis_DefinitionElement
       SET js1=NULL, js2=NULL, js3=NULL, js4=NULL, js5=NULL, js6=NULL, js7=NULL
       WHERE ECClassId=?`,
    ).run(ids.geometryPart);
    const left = countGeometryParts(db, ids);
    if (left.bytes !== 0)
      throw new Error(`Geometry still in bis_DefinitionElement: ${left.bytes} bytes.`);
  } else {
    // The foreign key runs child to parent, so bis_Element is untouched.
    db.prepare("DELETE FROM bis_DefinitionElement WHERE ECClassId=?").run(ids.geometryPart);
  }

  const surviving = (
    db.prepare("SELECT COUNT(*) n FROM bis_Element WHERE ECClassId=?").get(ids.geometryPart) as { n: number }
  ).n;
  if (surviving !== before.rows)
    throw new Error(`bis_Element lost rows: ${surviving} remain of ${before.rows}.`);
}

export interface RemapResult {
  parts: number;
  geometryBytes: number;
  strayMapsRemoved: number;
  extendedTypesPatched: number;
}

/** Every metadata and data change for one remap type, in a single transaction. */
export function mapipulateData(db: Database, profile: RemapProfile): RemapResult {
  const ids = resolveIds(db);
  if (geometryPartTableExists(db))
    throw new Error("bis_GeometryPart already exists; this iModel has already been converted.");

  const before = countGeometryParts(db, ids);
  if (before.rows === 0)
    throw new Error("No GeometryPart rows in bis_DefinitionElement; there is nothing to move.");

  let strayMapsRemoved = 0;
  let extendedTypesPatched = 0;

  db.transaction(() => {
    const parentTableId = profile.parentTable === "bis_Element" ? ids.elementTable : ids.definitionElementTable;
    const table = createGeometryPartTable(db, ids, parentTableId, profile.overrideIsPrivate);

    repointGeometryProperties(db, ids, table);
    if (profile.keepDefinitionRows) {
      addJoinedTableSystemMaps(db, ids, table);
    } else {
      strayMapsRemoved = severFromDefinitionElement(db, ids, table, profile.overrideIsPrivate);
      retargetClassHasTables(db, ids, table.tableId);
    }

    if (profile.reparent)
      reparentGeometryPart(db, ids);

    extendedTypesPatched = patchSystemExtendedTypes(db);
    setBisCoreVersion(db, profile.bisCoreDigit3);
    if (profile.ecDbVersion && profile.dgnDbVersion) {
      setProfileVersion(db, "ec_Db", profile.ecDbVersion);
      setProfileVersion(db, "dgn_Db", profile.dgnDbVersion);
    }

    migrateGeometryPartData(db, ids, before, profile.keepDefinitionRows, profile.overrideIsPrivate);
  })();

  return { parts: before.rows, geometryBytes: before.bytes, strayMapsRemoved, extendedTypesPatched };
}
