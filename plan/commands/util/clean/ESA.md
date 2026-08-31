# clean esa command details

Implementation details for the `imod util clean esa` commmand.

An External Source Aspect is a duplicate if the Element.Id, Scope.Id, Kind, Identifier and
JsonProperties are the same.  So for example a list of all duplicate ESA ordered by count of
duplicates can be found with the following ECSql query:

```sql
SELECT esa.Element.Id, esa.Scope.Id, esa.Kind, esa.Identifier, esa.JsonProperties, COUNT(*) as numberOfESA FROM bis.ExternalSourceAspect esa
GROUP BY esa.Element.Id, esa.Scope.Id, esa.Kind, esa.Identifier, esa.JsonProperties
HAVING numberOfESA > 1
ORDER BY numberOfESA DESC
```

Clean up removes all but one of the ESA duplicates leaving one ESA behind.

Implemented using Direct SQL calls for best performance.

## Implementation notes

**Which duplicate survives does not matter**, since the five identity properties are equal by
definition. `MIN(Id)` picks one so the answer is deterministic, not because it means anything:
an aspect id carries a briefcase prefix, so a lower id is not an older aspect. `Version`,
`Checksum` and `Source` are payload and take no part in the comparison, so a group whose
payloads differ in those still collapses to one aspect, and which payload survives is
unspecified.

**JsonProperties is compared as stored text.** Two aspects whose JSON differs only in key order
or whitespace are held to be different and both survive. That errs towards keeping aspects,
which is the safe direction for a delete.

**Finding the groups is one GROUP BY**, which yields the identity, the number of duplicates and
the aspect to keep in a single pass:

```sql
SELECT ElementId, <scope>, <identifier>, <kind>, <json>, COUNT(*) AS duplicates, MIN(Id) AS keeper
FROM bis_ElementMultiAspect
WHERE ECClassId=<esa>
GROUP BY ElementId, <scope>, <identifier>, <kind>, <json>
HAVING duplicates > 1
```

**Deletion is one statement per duplicate identity**, batched with a save every 5,000 groups:

```sql
DELETE FROM bis_ElementMultiAspect
WHERE ECClassId=? AND ElementId=? AND <scope> IS ? AND <identifier> IS ? AND <kind> IS ?
  AND <json> IS ? AND Id<>?
```

`IS` rather than `=` so a null matches a null; with `=` a null Scope would match nothing and the
duplicates would silently survive.

**Options.** `--dry-run` reports what would be deleted and opens the iModel read-only.
