import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import * as path from "node:path";
import { Schema, SchemaContext, SchemaKey } from "@itwin/ecschema-metadata";
import { getSchemaDifferences, SchemaMerger } from "@itwin/ecschema-editing";
import { SchemaXml, SchemaXmlFileLocater } from "@itwin/ecschema-locaters";

export interface MergeSchemaSetArgs {
  schemaPath: string;
  alias: string;
  outPath: string;
}

const SCHEMA_FILE_RE = /\.ecschema\.xml$/i;

export async function runMergeSchemaSet(args: MergeSchemaSetArgs): Promise<void> {
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
    const schema = await sourceSchemaContext.getSchema(SchemaKey.parseString(schemaName));
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
    for (const sourceSchema of schemasToMerge) {
      const differences = await getSchemaDifferences(targetSchema, sourceSchema);
      if(differences.conflicts) {
        console.log(`Conflicts found between ${targetSchema.schemaKey} and ${sourceSchema.schemaKey}, keeping source schema. Conflicts:`);
        differences.conflicts.forEach((c) => console.log(`  [${c.code}] ${c.description}`));
        await targetSchemaContext.getSchema(sourceSchema.schemaKey);
        continue;
      }
      await merger.merge(differences);
    }

    for (const schema of allSchemas) {
      if (schemasToMerge.find((s) => s.schemaKey.matches(schema.schemaKey)))
        continue;
      const targetSchema =await targetSchemaContext.getSchema(schema.schemaKey);
      if (targetSchema) {
        await SchemaXml.writeFile(targetSchema, path.join(args.outPath, `${targetSchema.fullName}.ecschema.xml`));
      }
    }
  }
}

export const mergeSchemaSetCommand: CommandModule<unknown, MergeSchemaSetArgs> = {
  command: "merge-schema-set",
  describe: "Merge schemas in a directory whose alias matches a regex",
  builder: (y) =>
    y
      .option("schema-path", { type: "string", demandOption: true, describe: "Directory containing .ecschema.xml files" })
      .option("alias", { type: "string", demandOption: true, describe: "Regex matched against each schema's alias attribute" })
      .option("out-path", { type: "string", demandOption: true, describe: "Output directory for merged schemas and report" }) as never,
  handler: async (argv) => {
    await runMergeSchemaSet({
      schemaPath: argv.schemaPath,
      alias: argv.alias,
      outPath: argv.outPath,
    });
  },
};
