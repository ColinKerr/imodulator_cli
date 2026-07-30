import { readFileSync } from "node:fs";

/**
 * Types and validation for the `imod transform using-map` mapping file. The
 * authoritative contract is ./element-mapping.schema.json; the checks here
 * mirror it and add the semantic rules a JSON schema cannot express (unique
 * source classes, unique property names within a mapping).
 */

export interface PropertyMappingOptions {
  DefaultValueIfEmpty?: string | number | boolean | null;
}

export interface PropertyMapping {
  SourceProperty: string;
  TargetProperty: string;
  Options?: PropertyMappingOptions;
}

export interface ClassMappingOptions {
  AutoMapLikeNamedProperties?: boolean;
}

export interface ClassMapping {
  SourceClass: string;
  TargetClass: string;
  Options?: ClassMappingOptions;
  PropertyMappings?: PropertyMapping[];
}

export interface ElementMapping {
  ClassMappings: ClassMapping[];
}

export interface MappingFile {
  ElementMapping: ElementMapping;
}

const EC_CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_]*[.:][A-Za-z_][A-Za-z0-9_]*$/;

/** Normalize a `Schema.Class` or `Schema:Class` name to the `Schema:Class` form iTwin.js uses for classFullName. */
export function toClassFullName(ecClassName: string): string {
  return ecClassName.replace(".", ":");
}

/** Read, parse, and validate a mapping file. Throws with an actionable message on any problem. */
export function loadMappingFile(path: string): MappingFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Mapping file not found or unreadable: ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`Mapping file is not valid JSON (${path}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseMapping(json);
}

/** Validate an already-parsed mapping object and return it typed. Throws on any structural or semantic problem. */
export function parseMapping(json: unknown): MappingFile {
  const root = asObject(json, "mapping");
  onlyKeys(root, ["ElementMapping"], "mapping");

  const elementMapping = asObject(root.ElementMapping, "ElementMapping");
  onlyKeys(elementMapping, ["ClassMappings"], "ElementMapping");

  const classMappings = elementMapping.ClassMappings;
  if (!Array.isArray(classMappings) || classMappings.length === 0)
    throw new Error("ElementMapping.ClassMappings must be a non-empty array.");

  const seenSourceClasses = new Set<string>();
  const validated = classMappings.map((cm, i) => {
    const mapping = validateClassMapping(cm, `ClassMappings[${i}]`);
    if (seenSourceClasses.has(mapping.SourceClass))
      throw new Error(`Duplicate SourceClass "${mapping.SourceClass}" in ClassMappings. Each source class may appear at most once.`);
    seenSourceClasses.add(mapping.SourceClass);
    return mapping;
  });

  return { ElementMapping: { ClassMappings: validated } };
}

function validateClassMapping(value: unknown, where: string): ClassMapping {
  const cm = asObject(value, where);
  onlyKeys(cm, ["SourceClass", "TargetClass", "Options", "PropertyMappings"], where);

  const SourceClass = asEcClassName(cm.SourceClass, `${where}.SourceClass`);
  const TargetClass = asEcClassName(cm.TargetClass, `${where}.TargetClass`);

  const result: ClassMapping = { SourceClass, TargetClass };

  if (cm.Options !== undefined) {
    const opts = asObject(cm.Options, `${where}.Options`);
    onlyKeys(opts, ["AutoMapLikeNamedProperties"], `${where}.Options`);
    if (opts.AutoMapLikeNamedProperties !== undefined) {
      if (typeof opts.AutoMapLikeNamedProperties !== "boolean")
        throw new Error(`${where}.Options.AutoMapLikeNamedProperties must be a boolean.`);
      result.Options = { AutoMapLikeNamedProperties: opts.AutoMapLikeNamedProperties };
    }
  }

  if (cm.PropertyMappings !== undefined) {
    if (!Array.isArray(cm.PropertyMappings))
      throw new Error(`${where}.PropertyMappings must be an array.`);
    const seenSource = new Set<string>();
    const seenTarget = new Set<string>();
    result.PropertyMappings = cm.PropertyMappings.map((pm, j) => {
      const mapping = validatePropertyMapping(pm, `${where}.PropertyMappings[${j}]`);
      if (seenSource.has(mapping.SourceProperty))
        throw new Error(`Duplicate SourceProperty "${mapping.SourceProperty}" in ${where}.PropertyMappings.`);
      if (seenTarget.has(mapping.TargetProperty))
        throw new Error(`Duplicate TargetProperty "${mapping.TargetProperty}" in ${where}.PropertyMappings.`);
      seenSource.add(mapping.SourceProperty);
      seenTarget.add(mapping.TargetProperty);
      return mapping;
    });
  }

  return result;
}

function validatePropertyMapping(value: unknown, where: string): PropertyMapping {
  const pm = asObject(value, where);
  onlyKeys(pm, ["SourceProperty", "TargetProperty", "Options"], where);

  const SourceProperty = asNonEmptyString(pm.SourceProperty, `${where}.SourceProperty`);
  const TargetProperty = asNonEmptyString(pm.TargetProperty, `${where}.TargetProperty`);
  const result: PropertyMapping = { SourceProperty, TargetProperty };

  if (pm.Options !== undefined) {
    const opts = asObject(pm.Options, `${where}.Options`);
    onlyKeys(opts, ["DefaultValueIfEmpty"], `${where}.Options`);
    if (opts.DefaultValueIfEmpty !== undefined) {
      const v = opts.DefaultValueIfEmpty;
      if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
        throw new Error(`${where}.Options.DefaultValueIfEmpty must be a string, number, boolean, or null.`);
      result.Options = { DefaultValueIfEmpty: v };
    }
  }

  return result;
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where} must be an object.`);
  return value as Record<string, unknown>;
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0)
    throw new Error(`Unexpected key(s) in ${where}: ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`);
}

function asEcClassName(value: unknown, where: string): string {
  const s = asNonEmptyString(value, where);
  if (!EC_CLASS_NAME.test(s))
    throw new Error(`${where} must be a fully qualified EC class name "Schema.Class" or "Schema:Class", got "${s}".`);
  return s;
}

function asNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${where} must be a non-empty string.`);
  return value;
}
