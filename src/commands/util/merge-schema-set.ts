import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import * as path from "node:path";
import { ECClassModifier, EntityClass, RelationshipClass, Schema, SchemaContext, SchemaKey } from "@itwin/ecschema-metadata";
import { getSchemaDifferences, SchemaMerger } from "@itwin/ecschema-editing";
import { SchemaXml, SchemaXmlFileLocater } from "@itwin/ecschema-locaters";
import { type ClassMapping, type MappingFile, parseMapping } from "../../transform/mapping-file";

export interface MergeSchemaSetArgs {
  schemaPath: string;
  alias: string;
  outPath: string;
  genMapping: boolean;
}

export interface MergeSchemaSetResult {
  /** Path of the generated `using-map` mapping file, when `--gen-mapping` produced one. */
  mappingPath?: string;
}

const SCHEMA_FILE_RE = /\.ecschema\.xml$/i;

export async function runMergeSchemaSet(args: MergeSchemaSetArgs): Promise<MergeSchemaSetResult> {
  const sourceSchemaContext = new SchemaContext();
  const locater = new SchemaXmlFileLocater();
  locater.addSchemaSearchPath(args.schemaPath);
  sourceSchemaContext.addLocater(locater);

  const schemaNames = fs.readdirSync(args.schemaPath).filter((f) => SCHEMA_FILE_RE.test(f)).map((f) => {
    return f.split('.')[0];
  });

  const aliasRegex = new RegExp(args.alias);

  const allSchemas: Schema[] = [];
  const schemasToMerge: Schema[] = [];
  for(const schemaName of schemaNames) {
    const schema = await sourceSchemaContext.getSchema(new SchemaKey(schemaName));
    if (schema) {
      allSchemas.push(schema);
      if (aliasRegex.test(schema.alias))
        schemasToMerge.push(schema);
    }
  }

  if (schemasToMerge.length > 1) {
    const targetSchemaContext = new SchemaContext();
    const targetLocater = new SchemaXmlFileLocater();
    targetLocater.addSchemaSearchPath(args.schemaPath);
    targetSchemaContext.addLocater(targetLocater);
    const firstSchema = schemasToMerge.pop()!;
    const targetSchema = await targetSchemaContext.getSchema(firstSchema.schemaKey);
    if (!targetSchema)
      throw new Error(`Failed to retrieve target schema: ${firstSchema.schemaKey}`);

    const merger = new SchemaMerger(targetSchemaContext);
    const mergedSources: Schema[] = [];
    for (const sourceSchema of schemasToMerge) {
      const differences = await getSchemaDifferences(targetSchema, sourceSchema);
      if(differences.conflicts) {
        console.log(`Conflicts found between ${targetSchema.schemaKey} and ${sourceSchema.schemaKey}, keeping source schema. Conflicts:`);
        differences.conflicts.forEach((c) => console.log(`  [${c.code}] ${c.description}`));
        await targetSchemaContext.getSchema(sourceSchema.schemaKey);
        continue;
      }
      await merger.merge(differences);
      mergedSources.push(sourceSchema);
    }

    for (const schema of allSchemas) {
      if (schemasToMerge.find((s) => s.schemaKey.matches(schema.schemaKey)))
        continue;
      const targetSchema =await targetSchemaContext.getSchema(schema.schemaKey);
      if (targetSchema) {
        await SchemaXml.writeFile(targetSchema, path.join(args.outPath, `${targetSchema.fullName}.ecschema.xml`));
      }
    }

    if (args.genMapping)
      return { mappingPath: await writeMergeMapping(targetSchema, mergedSources, args.outPath) };
  }

  return {};
}

/** Write a `using-map` mapping file migrating the merged-away schemas' instances onto the target schema. */
export async function writeMergeMapping(targetSchema: Schema, mergedSources: Schema[], outPath: string): Promise<string | undefined> {
  const mapping = await buildMergeMapping(targetSchema, mergedSources);
  if (mapping.ElementMapping.ClassMappings.length === 0) {
    console.log("No instance-bearing classes were merged; no mapping file generated.");
    return undefined;
  }
  parseMapping(mapping); // fail fast if the generated mapping is not valid for `using-map`
  const mappingPath = path.join(outPath, `${targetSchema.name}.mapping.json`);
  fs.writeFileSync(mappingPath, JSON.stringify(mapping, undefined, 2), "utf8");
  console.log(`Wrote mapping for ${mapping.ElementMapping.ClassMappings.length} class(es) to ${mappingPath}`);
  return mappingPath;
}

/**
 * Map every concrete entity (element/aspect) and relationship class of each merged-away schema to
 * the like-named class consolidated into the surviving target schema, so existing instance data
 * can be migrated with `imod transform using-map`.
 */
export async function buildMergeMapping(targetSchema: Schema, mergedSources: Schema[]): Promise<MappingFile> {
  const classMappings: ClassMapping[] = [];
  for (const source of mergedSources) {
    for (const item of [...source.getItems(EntityClass), ...source.getItems(RelationshipClass)]) {
      if (item.modifier === ECClassModifier.Abstract)
        continue;
      if (!(await targetSchema.getItem(item.name)))
        continue;
      classMappings.push({
        SourceClass: `${source.name}:${item.name}`,
        TargetClass: `${targetSchema.name}:${item.name}`,
        Options: { AutoMapLikeNamedProperties: true },
      });
    }
  }
  return { ElementMapping: { ClassMappings: classMappings } };
}

export const mergeSchemaSetCommand: CommandModule<unknown, MergeSchemaSetArgs> = {
  command: "merge-schema-set",
  describe: "Merge schemas in a directory whose alias matches a regex",
  builder: (y) =>
    y
      .option("schema-path", { type: "string", demandOption: true, describe: "Directory containing .ecschema.xml files" })
      .option("alias", { type: "string", demandOption: true, describe: "Regex matched against each schema's alias attribute" })
      .option("out-path", { type: "string", demandOption: true, describe: "Output directory for merged schemas and report" })
      .option("gen-mapping", {
        type: "boolean",
        default: false,
        describe: "Also write a mapping file for `imod transform using-map` that migrates merged-away schema instances",
      }) as never,
  handler: async (argv) => {
    await runMergeSchemaSet({
      schemaPath: argv.schemaPath,
      alias: argv.alias,
      outPath: argv.outPath,
      genMapping: argv.genMapping,
    });
  },
};
