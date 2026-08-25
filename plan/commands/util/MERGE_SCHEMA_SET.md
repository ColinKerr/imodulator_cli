# merge-schema-set Command details

Implementation details for the `imod util merge-schema-set` command.

Load all schemas found in the --schema-path directory into a single SchemaContext with a SchemaXmlFileLocater constructed with the schema path.  Once the schemas are loaded use the provided alias regex to filter the loaded schemas into the set to be merged. 

Use the `@itwin/ecschema-editing` `SchemaMerger` class to merge schemas.

If there is a conflict when merging a schema skip that schema and include it in the output directory.

## `--gen-mapping`

When `--gen-mapping` is set, after the merge a mapping file named `<targetSchema>.mapping.json` is written to `--out-path`. It maps every concrete element, aspect, and relationship class of each merged-away schema to the like-named class consolidated into the surviving target schema (with `AutoMapLikeNamedProperties` enabled), so existing instance data can be migrated with `imod transform using-map`. Abstract classes, structs, and the target schema's own classes are not mapped; conflicting (un-merged) schemas are excluded. The generated file is validated against the `using-map` format before being written.

Migration workflow:

1. `imod util merge-schema-set --schema-path … --out-path … --gen-mapping`
2. `imod edit import-schemas` the merged schema into the briefcase.
3. `imod transform using-map --map-file <targetSchema>.mapping.json …` to re-class the existing instances.
