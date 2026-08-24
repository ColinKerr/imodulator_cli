# mapipulate Command details

Implementation details for the `imod util mapipulate` command.

This command creates a copy of the iModel specified by `--imodel-path` that has `imod util update-profile` run on it and changes the mapping and data in the iModel in one of three ways described below.

1. Remap type 3000 - Applies BisCore 1.0.3000, which changes GeometryParts base class to derive from InformationContentElement instead of DefinitionElement.  This moves GeometryPart to it's own table.  It is a breaking change to the BisCore schema and breaks existing polymorphic queries on DefinitionElement.  Output files get the postfix `_im3000`.  The schema change is made directly in the `ec_` tables rather than imported: ECDb refuses a base class change on schema import, and the `ec_` tables are where the file's schema actually lives.
2. Remap type 3001 - Creates a bis_GeometryPart table manually and modifies the mapping for GeometryPart.GeometryStream so it is stored in the new bis_GeometryPart table.  The original shared column values in bis_DefinitionElement table for GeometryStream are nulled out but the rows remain.  This injects custom mapping entries in the ec_ tables but the BisCore schema and polymorphic queries on DefinitionElement remain compatible.  The ECDb profile is set to 4.0.3001.0 and the DgnDb profile is set to 2.0.3001.0 to ensure no new schemas can be inserted that would break the mapping.  Output files get the postfix `_im3001`.
3. Remap type 3002 - Creates a bis_GeometryPart table manually and modifies mapping for the entire GeometryPart class so it is stored in it's entirety in the new table.  The original rows are deleted from the bis_DefinitionElement table.  This injects custom mapping entries in the ec_ tables and breaks polymorphic queries on DefinitionElement but leaves GeometryPart's base class unchanged.  The ECDb profile is set to 4.0.3002.0 and the DgnDb profile is set to 2.0.3002.0 to ensure new schemas cannot be inserted that would break the mapping.  Output files get the postfix `_im3002`.  It imports an updated BisCore schema which adds a property override for IsPrivate to GeometryPart. — see [How 3002 releases the bis_DefinitionElement rows](#how-3002-releases-the-bis_definitionelement-rows).

In all three cases the data is fully updated to match the mapping.

If the `--validate` parameter is passed in the changes will be validated.

## Parameters

| parameter | type | default | what it does |
|---|---|---|---|
| `--imodel-path` | string | required | The iModel to convert. Opened read-only and never written — the command works on a copy. |
| `--remap-type` | `3000` \| `3001` \| `3002` | required | Which set of mapping changes to apply. See [What each remap type changes](#what-each-remap-type-changes). Also selects the output postfix and, for 3001 and 3002, the profile versions the file is marked with. |
| `--validate` | boolean | `false` | Compare the converted file against its source and report the [validation checks](#validation). Roughly doubles the runtime, because the tile check has to generate tiles on both files. |
| `--tile-models` | number | `10` | How many geometric models to compare root tiles for. `0` skips the tile check entirely, which is what makes the rest of `--validate` cheap enough to run routinely. Ignored without `--validate`. |
| `--force` | boolean | `false` | Overwrite an existing output file. Without it an existing `<name>_im<type>.bim` is an error, so a long conversion cannot silently destroy a previous result. |

The output path is derived, not given: `<name>_im<type>.bim` beside the source.

## Workflow

The same five steps run for every remap type. The order matters. See
[Ordering constraints](#ordering-constraints).

1. **Copy** `--imodel-path` to `<name>_im<type>.bim`. If the source has a live `-wal`, copy it too
   and checkpoint it into the copy — copying only the main file of a database with a live WAL
   yields a copy missing committed pages. The source is opened read-only and never written.
2. **Update the profile** of the copy, by running `imod util update-profile` against it. This
   brings both the BeSQLite/ECDb/DgnDb profiles and the domain schemas up to what the installed
   iTwin.js writes.
3. **Manipulate Mapping Tables** — create the table and edit the `ec_` metadata, all inside one transaction.
4. **Migrate the data** to match the new mapping, in the same transaction.
5. **VACUUM** the result.

Steps 3-5 are raw SQLite. The connection must use `journal_mode = delete` (no WAL while metadata
is being edited) and `foreign_keys = OFF`.

## The new table

Identical for all three remap types except for `ParentTableId`:

```sql
CREATE TABLE [bis_GeometryPart](
  [ElementId] INTEGER PRIMARY KEY, [ECClassId] INTEGER NOT NULL,
  [GeometryStream] BLOB,
  [BBoxLow_X] REAL, [BBoxLow_Y] REAL, [BBoxLow_Z] REAL,
  [BBoxHigh_X] REAL, [BBoxHigh_Y] REAL, [BBoxHigh_Z] REAL,
  FOREIGN KEY([ElementId]) REFERENCES [bis_Element]([Id]) ON DELETE CASCADE);
CREATE INDEX [ix_bis_GeometryPart_ecclassid] ON [bis_GeometryPart]([ECClassId]);
```

It must be a real table whose rowid is the ElementId: `GeometryStream::WriteGeometryStream`
(imodel-native `iModelCore/iModelPlatform/DgnCore/DgnElement.cpp:4138`) writes geometry through
`OpenBlobIO(..., elementId, ...)`, which resolves the class and property to a physical table and
column and then uses the ElementId as the rowid. Views and virtual tables cannot back it.

The metadata describing it:

| table | rows |
|---|---|
| `ec_Table` | one row, `Type` 1 (joined), `ParentTableId` per remap type, **`ExclusiveRootClassId` = GeometryPart** |
| `ec_Column` | nine rows — `ElementId` (kind 1, `OrdinalInPrimaryKey` 0), `ECClassId` (kind 2, NOT NULL), and the seven data columns (kind 0). `UniqueConstraint` and `CollationConstraint` are NOT NULL and must be written. |
| `ec_Index` + `ec_IndexColumn` | one index on `ECClassId`, `IsAutoGenerated` 1, `AppliesToSubclassesIfPartial` 1 |

**`ec_Table.ExclusiveRootClassId` must not be NULL.** Left NULL, plain ECSql keeps working but the
addon segfaults during element loading, as soon as any property map points at the table. Nothing
surfaces until an element is loaded, so this will not be caught by a query-only check.

## What each remap type changes

| | 3000 | 3001 | 3002 |
|---|---|---|---|
| schema import | — | — | BisCore + version 1.0.3002, `IsPrivate` declared on GeometryPart |
| `ec_Table.ParentTableId` | `bis_Element` | `bis_DefinitionElement` | `bis_Element` |
| `ec_ClassHasBaseClasses` | GeometryPart → InformationContentElement | untouched | untouched |
| `ec_cache_ClassHierarchy` | GeometryPart → DefinitionElement row deleted | untouched | untouched |
| property maps moved | all nine, plus `IsPrivate` map deleted | the seven geometry properties only | all ten, `IsPrivate` included |
| extra system maps | — | a second `ECInstanceId`/`ECClassId` pair on the new table | — |
| `ec_ClassMap.ShareColumnsMode` | set NULL for GeometryPart | untouched | set NULL for GeometryPart |
| `ec_cache_ClassHasTables` | retarget `bis_DefinitionElement` → `bis_GeometryPart` | untouched | retarget `bis_DefinitionElement` → `bis_GeometryPart` |
| `bis_DefinitionElement` rows | deleted | kept, `js1`..`js7` nulled | deleted |
| `ec_Db` / `dgn_Db` profile | unchanged | 4.0.3001.0 / 2.0.3001.0 | 4.0.3002.0 / 2.0.3002.0 |
| BisCore `VersionDigit3` | 3000 | 3001 | 3002 |

**The base class is the only difference between 3000 and 3002.** Both move every GeometryPart
property into the new table and delete the rows from `bis_DefinitionElement`, so both lose
GeometryParts from polymorphic queries over `bis.DefinitionElement` — measured on `station_512b`,
10,444 rows down to 1,777 under either, short by exactly the 8,667 GeometryParts. 3000 gets there
by reparenting the class to `InformationContentElement`, a real change to what a GeometryPart *is*.
3002 leaves it a DefinitionElement.

### How 3002 releases the bis_DefinitionElement rows

The obstacle is `IsPrivate`. A GeometryPart that is still a DefinitionElement inherits it, and
**ECDb resolves an inherited property through the class that declares it** — so every query
projecting `IsPrivate` joins `bis_DefinitionElement` whatever GeometryPart's own property map says.
Delete the rows and that inner join matches nothing: ECSql keeps returning parts for projections
that avoid the column, while `getElement` fails with `element not found` on every one of them.
Repointing GeometryPart's own map does not change the generated SQL, and neither does deleting it.

The fix is to make GeometryPart the declaring class, by importing a BisCore that overrides the
property on it:

```xml
<ECEntityClass typeName="GeometryPart" ...>
    <BaseClass>DefinitionElement</BaseClass>
    <ECProperty propertyName="IsPrivate" typeName="boolean" displayLabel="Is Private"
                description="If true, this bis:DefinitionElement should not be displayed in the GUI."/>
```

The import adds one `ec_Property` row for `GeometryPart.IsPrivate` and changes nothing else — the
property map still hangs off the base property's `ec_PropertyPath`, and the map row is in the same
place it was. What changes is that ECDb now consults *that* row, so repointing it at an `IsPrivate`
column on `bis_GeometryPart` takes effect and the generated SQL reads the new table alone:

```sql
SELECT [ElementId] ECInstanceId, [ECClassId], [GeometryStream], [IsPrivate]
FROM [main].[bis_GeometryPart]
```

The schema is derived from the BisCore the installed iTwin.js ships, with its minor version set to 3002, and imported through the normal API — no asset directory is
touched. It is imported **before** the profile bump, which is designed to make ECDb refuse any
schema import.

Two things were tried first and are recorded so they are not retried: giving the override its own
`ec_PropertyPath` (works, but the extra row is unnecessary — repointing the existing map is enough),
and deleting the `IsPrivate` map instead of moving it (the class then has an unmapped property and
`SELECT IsPrivate FROM bis.GeometryPart` fails to prepare with *No property or enumeration found*).

## Ordering constraints

**Update the profile first.** A `sub1` profile bump is specifically
designed to make ECDb refuse a profile upgrade (`iModelCore/BeSQLite/BeSQLite.cpp:3721` —
`Newer` sets `isUpgradable=false`), so once the file is mapipulated the iTwin.js API will not allow schema imports or profile upgrades. Code has special handling for older profiles, which will be broken when mapipulate updates the profile version.  Doing a profile update to get to the latest version ensures no special handling is required.  The upgrade is tile-neutral, so it does not compromise the comparison baseline.

**Both profiles move together, or neither.** `ProfileState::Merge`
(`iModelCore/BeSQLite/BeSQLite.cpp:3972`) has no representation for "one profile newer, another
older" and returns `Error()`, which surfaces as `BE_SQLITE_ERROR_InvalidProfileVersion` — an error
naming neither profile. A stock iModel is normally behind the software on both `ec_Db` and
`dgn_Db`, so bumping only one produces exactly that mixed state and the file will not open.

**The bump is required for 3001 and 3002.** Their `ec_cache_ClassHasTables` is not
rebuild-stable: a schema import would recompute it from `ec_PropertyMap` and undo the conversion.
`sub1` is the digit that matters — it makes ECDb refuse schema import
(`iModelCore/ECDb/ECDb/SchemaManagerDispatcher.cpp:1349`), schema drop (`:1137`) and profile
upgrade, which are the three routes to `RepopulateCacheTables()`. A `sub2`-only bump leaves import
allowed. 3000 needs no bump: its mapping is what ECDb would compute for the reparented class
anyway, so a rebuild is neutral.

## Validation

`--validate` compares the converted file against its source. Ordered cheap to expensive, and
nothing downstream is meaningful if the file does not open. Both files are opened read-only, with
the open mode passed **explicitly** — `openFile` defaults to ReadWrite when it is omitted, which
would open the source writable.

1. **Opens with iTwin.js**, and `SELECT COUNT(*) FROM BisCore.GeometryPart` returns the source's
   part count with every part's `GeometryStream` non-NULL.
2. **Elements load with their geometry** — read a sample of GeometryParts through the element API
   with `wantGeometry: true` and compare against the source. This is the only check that catches
   the extended-type and `ExclusiveRootClassId` failures, both of which leave ECSql working.
3. **`SELECT *` returns every row** for `bis.GeometryPart`, not just `COUNT(*)`. ECDb joins a
   class's tables with `INNER JOIN` and elides the join entirely when no column from the joined
   table is projected, so a `COUNT(*)` check passes over a partially populated table.
4. **Mapping structure** — nine property maps on `bis_GeometryPart`; on `bis_DefinitionElement`
   nothing for 3000/3002 and exactly `ECInstanceId`, `ECClassId`, `IsPrivate` for 3001; zero
   geometry bytes left in `bis_DefinitionElement.js1`.
5. **Class hierarchy and caches** match the remap type's row in the table above.
6. **Row counts identical to the source** — elements, aspects, relationships, models, and
   GeometryParts counted from `bis_Element`.
7. **Geometry bytes preserved** — `SUM(LENGTH(js1))` for GeometryParts in the source equals
   `SUM(LENGTH(GeometryStream))` in `bis_GeometryPart`.
8. **Polymorphic `bis.DefinitionElement` count** against the source. Identical for 3001; short by
   exactly the GeometryPart count for 3000 and 3002, which is the designed regression and is
   reported rather than failed.
9. **Root tiles**, below. This is the slowest check by far and the one the whole exercise exists
   to satisfy, so it runs last.

### Tiles

For each of the first `--tile-models` geometric models with geometry, request the primary tile tree
with edges at `defaultTileOptions`, fetch the root tile, and compare source against target. Root
tiles are the right unit: every model has exactly one, it is deterministic, and its content is a
function of the whole model's geometry, so a relocation that corrupts geometry is likely to show up
immediately.

Four outcomes per tile, so the report can distinguish a difference that was investigated and
accepted from one that was merely noticed:

| | meaning |
|---|---|
| `same` | byte-identical `sha256` |
| `~log` | bytes differ, tiles are logically equal |
| `nondet` | the source does not reproduce its own tile, so the two files cannot be compared here |
| `DIFF` | logically different — a failure |


