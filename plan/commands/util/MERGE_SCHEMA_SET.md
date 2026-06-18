# merge-schema-set Command details

Implementation details for the `imod util merge-schema-set` command.

Load all schemas found in the --schema-path directory into a single SchemaContext with a SchemaXmlFileLocater constructed with the schema path.  Once the schemas are loaded use the provided alias regex to filter the loaded schemas into the set to be merged. 

Use the `@itwin/ecschema-editing` `SchemaMerger` class to merge schemas.

If there is a conflict when merging a schema skip that schema and include it in the output directory.
