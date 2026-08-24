import type { IModelConnection } from "@itwin/core-frontend";

/** Schema, class and property names, for completion and for annotating id columns. */
export interface SchemaInfo {
  /** Schema name to its classes. */
  classesBySchema: Map<string, string[]>;
  /** `Schema.Class` to its property names. */
  propertiesByClass: Map<string, string[]>;
  /** Class id (lower case hex) to `Schema.Class`. */
  classNamesById: Map<string, string>;
}

export function emptySchemaInfo(): SchemaInfo {
  return { classesBySchema: new Map(), propertiesByClass: new Map(), classNamesById: new Map() };
}

/**
 * Read the iModel's schemas through ECDbMeta.
 *
 * This runs over the same query RPC as everything else, so it needs nothing from the backend
 * beyond an open iModel. The class id map is what lets the results table render
 * `0x42 (BisCore.Element)`.
 */
export async function loadSchemaInfo(imodel: IModelConnection): Promise<SchemaInfo> {
  const info = emptySchemaInfo();

  const classSql = `
    SELECT c.ECInstanceId, s.Name, c.Name
    FROM meta.ECClassDef c
    JOIN meta.ECSchemaDef s ON c.Schema.Id = s.ECInstanceId
    ORDER BY s.Name, c.Name`;
  for await (const row of imodel.createQueryReader(classSql)) {
    const [classId, schemaName, className] = row.toArray() as [string, string, string];
    const classes = info.classesBySchema.get(schemaName) ?? [];
    classes.push(className);
    info.classesBySchema.set(schemaName, classes);
    info.classNamesById.set(String(classId).toLowerCase(), `${schemaName}.${className}`);
  }

  const propertySql = `
    SELECT s.Name, c.Name, p.Name
    FROM meta.ECPropertyDef p
    JOIN meta.ECClassDef c ON p.Class.Id = c.ECInstanceId
    JOIN meta.ECSchemaDef s ON c.Schema.Id = s.ECInstanceId
    ORDER BY s.Name, c.Name, p.Name`;
  for await (const row of imodel.createQueryReader(propertySql)) {
    const [schemaName, className, propertyName] = row.toArray() as [string, string, string];
    const key = `${schemaName}.${className}`;
    const properties = info.propertiesByClass.get(key) ?? [];
    properties.push(propertyName);
    info.propertiesByClass.set(key, properties);
  }

  return info;
}
