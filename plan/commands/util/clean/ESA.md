# clean esa command details

Implementation details for the `imod util clean esa` commmand.

An External Source Aspect is a duplicate if the Element.Id, Scope.Id, Kind and Identifier are the same.  So for example a list of all duplicate ESA ordered by count of duplicates can be found with the following ECSql query:

```sql
SELECT esa.Element.Id, esa.Scope.Id, esa.Kind, esa.Identifier, COUNT(*) as numberOfESA FROM bis.ExternalSourceAspect esa
GROUP BY esa.Element.Id, esa.Scope.Id, esa.Kind, esa.Identifier
HAVING numberOfESA > 1
ORDER BY numberOfESA DESC
```

Clean up removes all but one of the ESA duplicates leaving one ESA behind.

Implemented using Direct SQL calls for best performance.

## Implementation notes

**Which duplicate survives does not matter**, since the four identity properties are equal by
definition. The first aspect of each identity the reader happens to return is kept and the rest
are deleted; nothing sorts to choose between them. The remaining properties — `Version`,
`Checksum`, `JsonProperties`, `Source` — are payload and take no part in the comparison, so a
group whose payloads differ still collapses to one aspect, and which payload survives is
unspecified.

**The scan walks the BisCore index; it does not sort.** The query above is the right shape for
reporting, but driving deletion from it needs a second query per group to fetch the ids. Instead:

```sql
SELECT Id, ElementId, <scope>, <identifier>, <kind>
FROM bis_ElementMultiAspect INDEXED BY ix_bis_ExternalSourceAspect_Source
WHERE ECClassId=<esa>
ORDER BY <scope>, <identifier>, <kind>
```

BisCore defines `ix_bis_ExternalSourceAspect_Source` on `(ps1, ps2, ps3) WHERE ECClassId=<esa>`, i.e.
(Scope, Identifier, Kind). Ordering by those three columns in that order lets SQLite walk the index
and skip the sort entirely — `SCAN ... USING INDEX ix_bis_ExternalSourceAspect_Source`. Element.Id
is not in the index, so it is grouped within each run instead; a run is normally one element.

**Deletion is one statement per duplicate identity**, batched with a save every 5,000 groups:

```sql
DELETE FROM bis_ElementMultiAspect
WHERE ECClassId=? AND ElementId=? AND <scope> IS ? AND <identifier> IS ? AND <kind> IS ? AND Id<>?
```

**Options.** `--dry-run` reports what would be deleted and opens the iModel read-only.
