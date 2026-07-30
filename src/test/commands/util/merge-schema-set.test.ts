import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema, SchemaContext } from "@itwin/ecschema-metadata";
import { buildMergeMapping, writeMergeMapping } from "../../../commands/util/merge-schema-set";
import { loadMappingFile } from "../../../transform/mapping-file";

// In-memory schemas exercise the mapping generation without the standard-schema and dynamic-schema
// machinery the SchemaMerger itself requires.
function entityClass(): object {
  return { schemaItemType: "EntityClass", properties: [{ name: "P", type: "PrimitiveProperty", typeName: "string" }] };
}

function relationshipClass(schema: string, source: string, target: string): object {
  return {
    schemaItemType: "RelationshipClass",
    strength: "Referencing",
    strengthDirection: "Forward",
    modifier: "Sealed",
    source: { multiplicity: "(0..*)", roleLabel: "a", polymorphic: true, constraintClasses: [`${schema}.${source}`] },
    target: { multiplicity: "(0..*)", roleLabel: "b", polymorphic: true, constraintClasses: [`${schema}.${target}`] },
  };
}

async function sourceSchema(context: SchemaContext): Promise<Schema> {
  return Schema.fromJson(
    {
      $schema: "https://dev.bentley.com/json_schemas/ec/32/ecschema",
      name: "SchemaOne",
      version: "01.00.00",
      alias: "one",
      items: {
        ElemOne: entityClass(),
        AspectOne: entityClass(),
        AbstractOne: { schemaItemType: "EntityClass", modifier: "Abstract" },
        OrphanOne: entityClass(), // not present in target -> excluded
        RelOne: relationshipClass("SchemaOne", "ElemOne", "AspectOne"),
      },
    },
    context,
  );
}

async function targetSchema(context: SchemaContext): Promise<Schema> {
  return Schema.fromJson(
    {
      $schema: "https://dev.bentley.com/json_schemas/ec/32/ecschema",
      name: "Target",
      version: "01.00.00",
      alias: "tgt",
      items: {
        // The classes consolidated from SchemaOne (post-merge), plus the target's own class.
        ElemOne: entityClass(),
        AspectOne: entityClass(),
        RelOne: relationshipClass("Target", "ElemOne", "AspectOne"),
        TargetOwn: entityClass(),
      },
    },
    context,
  );
}

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "imod-merge-out-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("merge-schema-set mapping generation", () => {
  it("maps each concrete source class to the like-named target class", async () => {
    const context = new SchemaContext();
    const target = await targetSchema(context);
    const source = await sourceSchema(new SchemaContext());

    const mapping = await buildMergeMapping(target, [source]);
    const mappings = mapping.ElementMapping.ClassMappings;

    // ElemOne, AspectOne, RelOne — abstract and the target-less Orphan are excluded.
    expect(mappings.map((m) => m.SourceClass).sort()).toEqual([
      "SchemaOne:AspectOne",
      "SchemaOne:ElemOne",
      "SchemaOne:RelOne",
    ]);
    for (const m of mappings) {
      expect(m.TargetClass).toBe(`Target:${m.SourceClass.split(":")[1]}`);
      expect(m.Options?.AutoMapLikeNamedProperties).toBe(true);
    }
  });

  it("writes a valid mapping file and skips writing when nothing was merged", async () => {
    const target = await targetSchema(new SchemaContext());
    const source = await sourceSchema(new SchemaContext());

    const path = await writeMergeMapping(target, [source], outDir);
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
    expect(loadMappingFile(path!).ElementMapping.ClassMappings).toHaveLength(3);

    // Nothing merged -> no mapping file.
    const none = await writeMergeMapping(target, [], outDir);
    expect(none).toBeUndefined();
    expect(readdirSync(outDir).filter((f) => f.endsWith(".mapping.json"))).toHaveLength(1);
  });
});
