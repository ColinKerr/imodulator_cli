# using-map command details

Implementation details for the `imod transform using-map` command.

This command should use the @itwin/imodel-transformer package to transform the elements.  Use the latest 2.0.0-dev.XX version available.

## Mapping JSON format

Format for the mapping file.

```JSON
{
"ElementMapping": {
    "ClassMappings": [
        {
            "SourceClass": "Generic.PhysicalObject",
            "TargetClass": "test.targetClass",
            "Options": {
                "AutoMapLikeNamedProperties": true,
            }
            "PropertyMappings": [
                {
                    "SourceProperty": "Banana",
                    "TargetProperty": "Apple",
                    "Options": {
                        "DefaultValueIfEmpty": 42
                    }
                }
            ]
        }
    ]
}
}
```

## Implementation details

- Element changes should be batched into groups of 5k elements with save changes called at the end of each batch.  
- Batches should be run using setImmediate to give the node event loop a chance to breath in this long running task.
- If there is an ambiguity in the transform it should fail instead of making an assumption or loosing data.
- Failures due to ambiguity should be resolvable by supplying new configuration information in the mapping file.

## How it works

The mapping file format is defined by [element-mapping.schema.json](../../../src/transform/element-mapping.schema.json) and parsed/validated in `src/transform/mapping-file.ts`. The transform itself lives in `src/transform/map-transformer.ts`.

Each mapped source class is classified as an **element**, **aspect**, or **relationship** class (from its BIS base), and transformed accordingly. Elements run through the transformer below; aspects and relationships are re-classed by inserting a new instance of the target class (copying/remapping properties) and deleting the original.

Element conversion runs as an **in-place** `IModelTransformer` with the briefcase as both source and target:

- A new element of the target class is inserted for each mapped element, then the original is deleted ("replace originals"). EC class is immutable, so the converted elements receive new ids.
- Every element that is **not** being converted is identity-remapped (`context.remapElement(id, id)`) before processing, so the transformer reuses existing models/categories/etc. instead of inserting duplicates.
- `processElement` recurses into child elements, so parent/child references are remapped automatically and deleting an original cascade-deletes its original children.

Ambiguity / data-loss is detected by `resolvePropertyMap`, which looks at each source class's **own** (non-inherited) properties. A property that is neither explicitly mapped, nor like-named on the target with `AutoMapLikeNamedProperties` enabled, fails the transform with a message naming the property — resolvable by editing the mapping file.

### Inbound references

Because a converted element gets a new id, anything pointing at the original must be re-pointed before the original is deleted. After conversion (and before deletion) the transform:

- enumerates every navigation property in the iModel's schemas and re-points the ones that target a converted element via `updateElement`;
- finds link-table relationships (`bis:ElementRefersToElements` / `bis:ElementDrivesElement` and subclasses) whose endpoints target a converted element and re-points them by **delete + re-insert** (link-table endpoints are immutable, and deleting the original would otherwise cascade-delete the relationship).

Parent/child containment references are already handled by the transformer's child recursion, so by the time re-pointing runs they no longer point at an original id.

### Known limitation

Converting *modeled* elements (a partition/subject that a model is sub-modeling) is not supported; only leaf data elements should be mapped.
