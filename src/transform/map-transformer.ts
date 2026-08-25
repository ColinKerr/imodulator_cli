import type { EditTxn, Element, IModelDb } from "@itwin/core-backend";
import { IModelTransformer } from "@itwin/imodel-transformer";
import type { ElementAspectProps, ElementProps, RelationshipProps } from "@itwin/core-common";
import { ECClass, EntityClass, SchemaItemType } from "@itwin/ecschema-metadata";
import { type ClassMapping, toClassFullName } from "./mapping-file";

const BATCH_SIZE = 5000;
/** Max ids per ECSql `IN (...)` clause when scanning for inbound references. */
const ID_CHUNK = 500;
/** Link-table relationship base classes whose endpoints may reference a converted element. */
const LINK_TABLE_BASES = ["BisCore.ElementRefersToElements", "BisCore.ElementDrivesElement"];

export interface PropertyRename {
  sourceJsName: string;
  targetJsName: string;
  defaultIfEmpty?: string | number | boolean | null;
}

/** What kind of instance a mapping's source class holds, which determines how it is transformed. */
export type ClassKind = "element" | "aspect" | "relationship";

export interface ResolvedClassMapping {
  kind: ClassKind;
  /** `Schema:Class` form used for classFullName. */
  sourceClassFullName: string;
  targetClassFullName: string;
  /** Explicit property renames to apply; like-named properties are carried automatically. */
  renames: PropertyRename[];
}

export interface MapTransformResult {
  converted: number;
  /** Instance count converted, keyed by `Schema:Class` source class. */
  perClass: Record<string, number>;
  /** Inbound navigation-property references re-pointed to the converted elements. */
  navReferencesRepointed: number;
  /** Inbound link-table relationships re-pointed to the converted elements. */
  linkRelationshipsRepointed: number;
  /** ElementAspect instances re-classed to their target class. */
  aspectsConverted: number;
  /** Relationship instances re-classed to their target class. */
  relationshipsConverted: number;
}

/** EC property name to the lower-camel key used in element JSON props (e.g. `Note` -> `note`). */
function toJsName(ecPropertyName: string): string {
  return ecPropertyName.length === 0 ? ecPropertyName : ecPropertyName[0].toLowerCase() + ecPropertyName.slice(1);
}

/** `Schema:Class` to the dotted form ECSql expects in a FROM clause. */
function toEcsqlClassName(classFullName: string): string {
  return classFullName.replace(":", ".");
}

/**
 * Validate a class mapping against the iModel's schemas and resolve it into the concrete
 * property renames to apply. Fails (rather than silently dropping data) when a source-class
 * property would be lost: any property defined on the source class that has no explicit
 * PropertyMapping and either does not exist on the target class, or exists there but
 * `AutoMapLikeNamedProperties` was not enabled. Such failures are resolvable by editing the
 * mapping file.
 */
export async function resolvePropertyMap(db: IModelDb, mapping: ClassMapping): Promise<ResolvedClassMapping> {
  const sourceClassFullName = toClassFullName(mapping.SourceClass);
  const targetClassFullName = toClassFullName(mapping.TargetClass);

  const sourceItem = await db.schemaContext.getSchemaItem(sourceClassFullName);
  if (!sourceItem)
    throw new Error(`SourceClass not found in iModel: ${mapping.SourceClass}`);
  const targetItem = await db.schemaContext.getSchemaItem(targetClassFullName);
  if (!targetItem)
    throw new Error(`TargetClass not found in iModel: ${mapping.TargetClass}`);
  if (!ECClass.isECClass(sourceItem) || !ECClass.isECClass(targetItem))
    throw new Error(`SourceClass and TargetClass must be EC classes: ${mapping.SourceClass} -> ${mapping.TargetClass}`);
  const sourceClass = sourceItem;
  const targetClass = targetItem;
  const kind = await classifyKind(sourceClass, mapping.SourceClass);

  const explicitSource = new Set<string>();
  const renames: PropertyRename[] = [];
  for (const pm of mapping.PropertyMappings ?? []) {
    const sourceProp = await sourceClass.getProperty(pm.SourceProperty);
    if (!sourceProp)
      throw new Error(`PropertyMapping SourceProperty "${pm.SourceProperty}" not found on ${mapping.SourceClass}.`);
    const targetProp = await targetClass.getProperty(pm.TargetProperty);
    if (!targetProp)
      throw new Error(`PropertyMapping TargetProperty "${pm.TargetProperty}" not found on ${mapping.TargetClass}.`);
    explicitSource.add(sourceProp.name.toLowerCase());
    renames.push({
      sourceJsName: toJsName(sourceProp.name),
      targetJsName: toJsName(targetProp.name),
      defaultIfEmpty: pm.Options?.DefaultValueIfEmpty,
    });
  }

  const autoMap = mapping.Options?.AutoMapLikeNamedProperties === true;
  const problems: string[] = [];
  for (const prop of await sourceClass.getProperties(true /* excludeInherited */)) {
    if (explicitSource.has(prop.name.toLowerCase()))
      continue;
    const onTarget = await targetClass.getProperty(prop.name);
    if (!onTarget)
      problems.push(`property "${prop.name}" has no matching property on the target class`);
    else if (!autoMap)
      problems.push(`property "${prop.name}" exists on the target but AutoMapLikeNamedProperties is not enabled`);
  }
  if (problems.length > 0)
    throw new Error(
      `Ambiguous mapping ${mapping.SourceClass} -> ${mapping.TargetClass}: ${problems.join("; ")}. ` +
        `Add a PropertyMapping (or enable AutoMapLikeNamedProperties) to resolve.`,
    );

  return { kind, sourceClassFullName, targetClassFullName, renames };
}

/** Classify the source class as an element, aspect, or relationship for transform purposes. */
async function classifyKind(sourceClass: ECClass, displayName: string): Promise<ClassKind> {
  if (sourceClass.schemaItemType === SchemaItemType.RelationshipClass)
    return "relationship";
  if (sourceClass.schemaItemType === SchemaItemType.EntityClass) {
    if (await (sourceClass as EntityClass).is("ElementAspect", "BisCore"))
      return "aspect";
    if (await (sourceClass as EntityClass).is("Element", "BisCore"))
      return "element";
  }
  throw new Error(`SourceClass ${displayName} is not an element, aspect, or relationship class.`);
}

/** Same-iModel transformer that rewrites the class (and chosen properties) of mapped elements. */
class MapTransformer extends IModelTransformer {
  private readonly bySourceClass: Map<string, ResolvedClassMapping>;

  /** `editTxn` must already be started: the importer takes ownership of the write surface. */
  public constructor(editTxn: EditTxn, resolved: ResolvedClassMapping[]) {
    super(
      { source: editTxn.iModel, target: editTxn },
      { noProvenance: true, danglingReferencesBehavior: "reject" },
    );
    this.bySourceClass = new Map(resolved.map((r) => [r.sourceClassFullName, r]));
  }

  public override async onTransformElement(sourceElement: Element): Promise<ElementProps> {
    const props = await super.onTransformElement(sourceElement);
    const mapping = this.bySourceClass.get(sourceElement.classFullName);
    if (!mapping)
      return props;

    props.classFullName = mapping.targetClassFullName;
    const source = sourceElement.toJSON() as unknown as Record<string, unknown>;
    const target = props as unknown as Record<string, unknown>;
    // The cloned props carry source values under source-named keys; rewrite renamed ones.
    for (const rename of mapping.renames)
      if (target[rename.sourceJsName] === undefined && source[rename.sourceJsName] !== undefined)
        target[rename.sourceJsName] = source[rename.sourceJsName];
    applyRenames(target, mapping.renames);
    return props;
  }
}

async function queryInstanceIds(db: IModelDb, classFullName: string): Promise<string[]> {
  const ids: string[] = [];
  const reader = db.createQueryReader(`SELECT ECInstanceId FROM ONLY ${toEcsqlClassName(classFullName)}`);
  for await (const row of reader)
    ids.push(row[0] as string);
  return ids;
}

/** Count the instances that each resolved mapping would convert (used by `--dry-run`). */
export async function countBySourceClass(db: IModelDb, resolved: ResolvedClassMapping[]): Promise<Record<string, number>> {
  const perClass: Record<string, number> = {};
  for (const r of resolved)
    perClass[r.sourceClassFullName] = (await queryInstanceIds(db, r.sourceClassFullName)).length;
  return perClass;
}

/** Apply explicit property renames (with empty-value defaults) to a JSON props bag in place. */
function applyRenames(props: Record<string, unknown>, renames: PropertyRename[]): void {
  for (const rename of renames) {
    let value = props[rename.sourceJsName];
    if ((value === undefined || value === null || value === "") && rename.defaultIfEmpty !== undefined)
      value = rename.defaultIfEmpty;
    if (value !== undefined)
      props[rename.targetJsName] = value;
    if (rename.sourceJsName !== rename.targetJsName)
      delete props[rename.sourceJsName];
  }
}

/** Remap any `{ id }` reference value (nav property, owner, etc.) onto a converted element's new id. */
function remapNavValues(props: Record<string, unknown>, oldToNew: Map<string, string>): void {
  if (oldToNew.size === 0)
    return;
  for (const value of Object.values(props)) {
    if (value && typeof value === "object" && "id" in value) {
      const ref = value as { id: string };
      const newId = oldToNew.get(ref.id);
      if (newId)
        ref.id = newId;
    }
  }
}

/**
 * Convert the mapped instances in `db` to their target classes, leaving a pushable changeset.
 * Elements are converted in place via the transformer (then their originals deleted and inbound
 * references re-pointed); aspects and relationships are re-classed by inserting a new instance of
 * the target class and deleting the original. Changes are saved every {@link BATCH_SIZE}
 * instances, yielding to the event loop between batches.
 */
export async function runMapTransform(editTxn: EditTxn, resolved: ResolvedClassMapping[]): Promise<MapTransformResult> {
  const elementMappings = resolved.filter((r) => r.kind === "element");
  const relationshipMappings = resolved.filter((r) => r.kind === "relationship");
  const aspectMappings = resolved.filter((r) => r.kind === "aspect");

  const perClass: Record<string, number> = {};
  const result: MapTransformResult = {
    converted: 0,
    perClass,
    navReferencesRepointed: 0,
    linkRelationshipsRepointed: 0,
    aspectsConverted: 0,
    relationshipsConverted: 0,
  };

  const oldToNew = await convertElements(editTxn, elementMappings, perClass, result);

  // Relationships and aspects reference elements, so re-class them after element ids settle.
  for (const mapping of relationshipMappings) {
    const n = await reclassRelationships(editTxn, mapping, oldToNew);
    perClass[mapping.sourceClassFullName] = n;
    result.relationshipsConverted += n;
  }
  for (const mapping of aspectMappings) {
    const n = await reclassAspects(editTxn, mapping, oldToNew);
    perClass[mapping.sourceClassFullName] = n;
    result.aspectsConverted += n;
  }

  editTxn.saveChanges("transform using-map complete");
  return result;
}

/** Convert element mappings in place; returns the old-id to new-id map for downstream passes. */
async function convertElements(
  editTxn: EditTxn,
  elementMappings: ResolvedClassMapping[],
  perClass: Record<string, number>,
  result: MapTransformResult,
): Promise<Map<string, string>> {
  const oldToNew = new Map<string, string>();
  if (elementMappings.length === 0)
    return oldToNew;

  const convertIds: string[] = [];
  const convertSet = new Set<string>();
  for (const r of elementMappings) {
    const ids = await queryInstanceIds(editTxn.iModel, r.sourceClassFullName);
    perClass[r.sourceClassFullName] = ids.length;
    for (const id of ids) {
      convertIds.push(id);
      convertSet.add(id);
    }
  }

  const transformer = new MapTransformer(editTxn, elementMappings);
  try {
    for await (const row of editTxn.iModel.createQueryReader("SELECT ECInstanceId FROM bis.Element")) {
      const id = row[0] as string;
      if (!convertSet.has(id))
        transformer.context.remapElement(id, id);
    }

    let processed = 0;
    for (const id of convertIds) {
      await transformer.processElement(id);
      oldToNew.set(id, transformer.context.findTargetElementId(id));
      if (++processed % BATCH_SIZE === 0)
        await saveBatch(editTxn, `transform using-map: converted ${processed} element(s)`);
    }

    // Re-point inbound references onto the new elements before deleting the originals, so
    // nothing is left dangling (containment/parent references are already handled by the
    // transformer's child recursion).
    const repointed = await repointInboundReferences(editTxn, oldToNew);
    result.navReferencesRepointed = repointed.navUpdated;
    result.linkRelationshipsRepointed = repointed.linksRepointed;

    let deleted = 0;
    for (const id of convertIds) {
      editTxn.deleteElement(id);
      if (++deleted % BATCH_SIZE === 0)
        await saveBatch(editTxn, `transform using-map: removed ${deleted} original(s)`);
    }
  } finally {
    transformer.dispose();
  }

  result.converted = convertIds.length;
  return oldToNew;
}

/** Re-class every relationship instance of a source relationship class to its target class. */
async function reclassRelationships(editTxn: EditTxn, mapping: ResolvedClassMapping, oldToNew: Map<string, string>): Promise<number> {
  const ids = await queryInstanceIds(editTxn.iModel, mapping.sourceClassFullName);
  let n = 0;
  for (const id of ids) {
    const original = editTxn.iModel.relationships.getInstanceProps<RelationshipProps>(mapping.sourceClassFullName, id);
    const newProps = { ...original } as unknown as Record<string, unknown>;
    delete newProps.id;
    newProps.classFullName = mapping.targetClassFullName;
    if (oldToNew.size > 0) {
      newProps.sourceId = oldToNew.get(original.sourceId) ?? original.sourceId;
      newProps.targetId = oldToNew.get(original.targetId) ?? original.targetId;
    }
    applyRenames(newProps, mapping.renames);
    editTxn.deleteRelationship(original);
    editTxn.insertRelationship(newProps as unknown as RelationshipProps);
    if (++n % BATCH_SIZE === 0)
      await saveBatch(editTxn, `transform using-map: re-classed ${n} relationship(s)`);
  }
  return n;
}

/** Re-class every aspect instance of a source aspect class to its target class. */
async function reclassAspects(editTxn: EditTxn, mapping: ResolvedClassMapping, oldToNew: Map<string, string>): Promise<number> {
  const elementIds = new Set<string>();
  const reader = editTxn.iModel.createQueryReader(`SELECT Element.Id FROM ONLY ${toEcsqlClassName(mapping.sourceClassFullName)}`);
  for await (const row of reader)
    elementIds.add(row[0] as string);

  let n = 0;
  for (const elementId of elementIds) {
    for (const aspect of editTxn.iModel.elements.getAspects(elementId, mapping.sourceClassFullName)) {
      const props = aspect.toJSON() as unknown as Record<string, unknown>;
      const oldAspectId = props.id as string;
      delete props.id;
      props.classFullName = mapping.targetClassFullName;
      remapNavValues(props, oldToNew);
      applyRenames(props, mapping.renames);
      editTxn.insertAspect(props as unknown as ElementAspectProps);
      editTxn.deleteAspect(oldAspectId);
      if (++n % BATCH_SIZE === 0)
        await saveBatch(editTxn, `transform using-map: re-classed ${n} aspect(s)`);
    }
  }
  return n;
}

/** A navigation property that may reference a converted element. */
interface NavPropRef {
  schemaName: string;
  className: string;
  ecProp: string;
  jsProp: string;
  relClassName: string;
}

/**
 * Enumerate every navigation property defined on an element class in the iModel. Limited to
 * element classes because re-pointing happens through `IModelDb.Elements.updateElement`.
 */
async function discoverNavProps(db: IModelDb): Promise<NavPropRef[]> {
  const classFullNames: string[] = [];
  for await (const row of db.createQueryReader("SELECT ec_classname(ECInstanceId, 's:c') FROM meta.ECClassDef"))
    classFullNames.push(row[0] as string);

  const navProps: NavPropRef[] = [];
  for (const fullName of classFullNames) {
    const cls = await db.schemaContext.getSchemaItem(fullName, EntityClass);
    if (!cls || !(await cls.is("Element", "BisCore")))
      continue;
    let ownProps;
    try {
      ownProps = await cls.getProperties(true /* excludeInherited */);
    } catch {
      continue;
    }
    for (const prop of ownProps) {
      if (!prop.isNavigation())
        continue;
      const [schemaName, className] = fullName.split(":");
      const rel = await prop.relationshipClass;
      navProps.push({
        schemaName,
        className,
        ecProp: prop.name,
        jsProp: toJsName(prop.name),
        relClassName: rel.fullName.replace(".", ":"),
      });
    }
  }
  return navProps;
}

/**
 * Re-point every inbound navigation-property and link-table reference that targets a converted
 * element so it points at the element's replacement. `oldToNew` maps each converted element's
 * original id to its new id.
 */
async function repointInboundReferences(
  editTxn: EditTxn,
  oldToNew: Map<string, string>,
): Promise<{ navUpdated: number; linksRepointed: number }> {
  const oldIds = [...oldToNew.keys()];
  if (oldIds.length === 0)
    return { navUpdated: 0, linksRepointed: 0 };

  let saves = 0;
  const flush = async (message: string): Promise<void> => {
    if (++saves % BATCH_SIZE === 0)
      await saveBatch(editTxn, message);
  };

  let navUpdated = 0;
  for (const np of await discoverNavProps(editTxn.iModel)) {
    for (const chunk of chunked(oldIds, ID_CHUNK)) {
      const sql = `SELECT ECInstanceId, [${np.ecProp}].Id FROM [${np.schemaName}].[${np.className}] WHERE [${np.ecProp}].Id IN (${chunk.join(",")})`;
      const hits: { referencerId: string; oldTarget: string }[] = [];
      try {
        for await (const row of editTxn.iModel.createQueryReader(sql))
          hits.push({ referencerId: row[0] as string, oldTarget: row[1] as string });
      } catch {
        continue; // class not queryable for this property; skip
      }
      for (const hit of hits) {
        // A converted original's own clone already had its references remapped; skip it.
        if (oldToNew.has(hit.referencerId))
          continue;
        const newTarget = oldToNew.get(hit.oldTarget);
        if (!newTarget)
          continue;
        const props = editTxn.iModel.elements.getElementProps(hit.referencerId) as unknown as Record<string, unknown>;
        props[np.jsProp] = { id: newTarget, relClassName: np.relClassName };
        editTxn.updateElement(props as unknown as ElementProps);
        navUpdated++;
        await flush(`transform using-map: re-pointed ${navUpdated} reference(s)`);
      }
    }
  }

  let linksRepointed = 0;
  for (const base of LINK_TABLE_BASES) {
    const rowsById = new Map<string, { cls: string; src: string; tgt: string }>();
    for (const chunk of chunked(oldIds, ID_CHUNK)) {
      const inList = chunk.join(",");
      const sql = `SELECT ECInstanceId, ec_classname(ECClassId, 's:c'), SourceECInstanceId, TargetECInstanceId FROM ${base} WHERE SourceECInstanceId IN (${inList}) OR TargetECInstanceId IN (${inList})`;
      try {
        for await (const row of editTxn.iModel.createQueryReader(sql))
          rowsById.set(row[0] as string, { cls: row[1] as string, src: row[2] as string, tgt: row[3] as string });
      } catch {
        break; // base class absent; move on
      }
    }
    for (const [id, row] of rowsById) {
      const newSrc = oldToNew.get(row.src) ?? row.src;
      const newTgt = oldToNew.get(row.tgt) ?? row.tgt;
      if (newSrc === row.src && newTgt === row.tgt)
        continue;
      // Endpoints are immutable, so delete and re-insert with the new endpoints.
      const props = editTxn.iModel.relationships.getInstanceProps<RelationshipProps>(row.cls, id);
      editTxn.deleteRelationship(props);
      editTxn.insertRelationship({ classFullName: row.cls, sourceId: newSrc, targetId: newTgt } as RelationshipProps);
      linksRepointed++;
      await flush(`transform using-map: re-pointed ${linksRepointed} relationship(s)`);
    }
  }

  return { navUpdated, linksRepointed };
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size));
  return chunks;
}

async function saveBatch(editTxn: EditTxn, message: string): Promise<void> {
  editTxn.saveChanges(message);
  await new Promise((resolve) => setImmediate(resolve));
}
