/** Schema, class and property names, for completion and for annotating id columns. */
export interface SchemaInfo {
  /**
   * Schema name *and* alias to that schema's classes: `BisCore.Element` and `bis.Element` are
   * both valid ECSql, so both are valid keys. Keys are lower cased because ECSql identifiers
   * are case-insensitive.
   */
  classesBySchema: Map<string, string[]>;
  /** `<schema-or-alias>.<class>` to its property names, lower cased. */
  propertiesByClass: Map<string, string[]>;
  /** Class id (lower case hex) to the canonical `Schema.Class`. */
  classNamesById: Map<string, string>;
  /** Every schema, for completing the prefix itself. */
  schemas: { name: string; alias: string }[];
}

export function emptySchemaInfo(): SchemaInfo {
  return { classesBySchema: new Map(), propertiesByClass: new Map(), classNamesById: new Map(), schemas: [] };
}

const key = (...parts: string[]): string => parts.join(".").toLowerCase();

/** `[schema id, schema name, schema alias, class id, class name]`. */
export type ClassRow = [string, string, string, string, string];
/** `[schema name, schema alias, class name, property name]`. */
export type PropertyRow = [string, string, string, string];

/**
 * Index the schema rows for completion.
 *
 * Every class and property is registered under both the schema's name and its alias. Schema
 * names and aliases are unique across an iModel, so the two key spaces cannot collide.
 */
export function buildSchemaInfo(classRows: ClassRow[], propertyRows: PropertyRow[]): SchemaInfo {
  const info = emptySchemaInfo();
  const seenSchemas = new Set<string>();

  for (const [, schemaName, alias, classId, className] of classRows) {
    if (!seenSchemas.has(schemaName)) {
      seenSchemas.add(schemaName);
      info.schemas.push({ name: schemaName, alias });
    }
    for (const prefix of [schemaName, alias]) {
      if (!prefix)
        continue;
      const classes = info.classesBySchema.get(key(prefix)) ?? [];
      classes.push(className);
      info.classesBySchema.set(key(prefix), classes);
    }
    info.classNamesById.set(String(classId).toLowerCase(), `${schemaName}.${className}`);
  }

  // A property overridden in a subclass is declared more than once in the class's ancestry,
  // so the same name can arrive twice for one class.
  const seenProperties = new Set<string>();
  for (const [schemaName, alias, className, propertyName] of propertyRows) {
    for (const prefix of [schemaName, alias]) {
      if (!prefix)
        continue;
      const classKey = key(prefix, className);
      const seen = `${classKey}.${propertyName.toLowerCase()}`;
      if (seenProperties.has(seen))
        continue;
      seenProperties.add(seen);
      const properties = info.propertiesByClass.get(classKey) ?? [];
      properties.push(propertyName);
      info.propertiesByClass.set(classKey, properties);
    }
  }

  return info;
}

/** The classes a prefix names, where the prefix is a schema name or its alias. */
export function classesFor(info: SchemaInfo, prefix: string): string[] {
  return info.classesBySchema.get(prefix.toLowerCase()) ?? [];
}

/** The properties of a class, given the prefix and class name written in the query. */
export function propertiesFor(info: SchemaInfo, prefix: string, className: string): string[] {
  return info.propertiesByClass.get(key(prefix, className)) ?? [];
}

/**
 * The properties of every class with this name, whatever schema it is in.
 *
 * Used when a bare class name is qualified, as in `Element.`, where the schema is not stated.
 */
export function propertiesForClassName(info: SchemaInfo, className: string): string[] {
  const suffix = `.${className.toLowerCase()}`;
  const properties = new Set<string>();
  for (const [classKey, names] of info.propertiesByClass) {
    if (!classKey.endsWith(suffix))
      continue;
    for (const name of names)
      properties.add(name);
  }
  return [...properties];
}

/** The part of a query reader this needs, so a backend iModel can drive it in tests. */
export interface SchemaQueryable {
  createQueryReader(ecsql: string): AsyncIterable<{ toArray(): unknown[] }>;
}

/**
 * Read the iModel's schemas through ECDbMeta.
 *
 * This runs over the same query RPC as everything else, so it needs nothing from the backend
 * beyond an open iModel. The class id map is what lets the results table render
 * `0x42 (BisCore.Element)`.
 */
export async function loadSchemaInfo(imodel: SchemaQueryable): Promise<SchemaInfo> {
  const classRows: ClassRow[] = [];
  const classSql = `
    SELECT s.ECInstanceId, s.Name, s.Alias, c.ECInstanceId, c.Name
    FROM meta.ECClassDef c
    JOIN meta.ECSchemaDef s ON c.Schema.Id = s.ECInstanceId
    ORDER BY s.Name, c.Name`;
  for await (const row of imodel.createQueryReader(classSql))
    classRows.push(row.toArray() as ClassRow);

  // Properties are gathered through the class's whole ancestry, not just what it declares:
  // most concrete classes declare nothing of their own -- Generic.PhysicalObject declares
  // zero -- so completing only declared properties would offer nothing where it matters most.
  const propertyRows: PropertyRow[] = [];
  const propertySql = `
    SELECT s.Name, s.Alias, c.Name, p.Name
    FROM meta.ECPropertyDef p
    JOIN meta.ClassHasAllBaseClasses ancestry ON p.Class.Id = ancestry.TargetECInstanceId
    JOIN meta.ECClassDef c ON ancestry.SourceECInstanceId = c.ECInstanceId
    JOIN meta.ECSchemaDef s ON c.Schema.Id = s.ECInstanceId
    ORDER BY s.Name, c.Name, p.Name`;
  for await (const row of imodel.createQueryReader(propertySql))
    propertyRows.push(row.toArray() as PropertyRow);

  return buildSchemaInfo(classRows, propertyRows);
}
