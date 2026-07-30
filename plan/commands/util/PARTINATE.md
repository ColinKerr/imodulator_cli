# partinate command details

The partinate command moves the geometry of large `GeometricElement3d` elements into
dedicated `GeometryPart` elements that the original elements then reference. Elements
whose stored `GeometryStream` blob exceeds `--blob-size` bytes are converted; smaller
elements are left untouched.

## Overview

The command is specified by:

- `--imodel-path` - path to the local iModel file (opened as a writable briefcase).
- `--blob-size` - byte threshold; only elements whose stored `GeometryStream` blob is
  larger than this are converted. Defaults to `1024` (1 KiB).

Partinate does **not** edit the underlying SQLite tables directly. `GeometryStream`
blobs are serialized geometry and a `GeometryPart` requires proper BIS bookkeeping, so
all edits go through the iTwin.js `@itwin/core-backend` element API.
Changes are committed with `saveChanges`, producing a local change set that can be
pushed with `imod hub briefcase push`.

## Algorithm

1. Open the iModel as a writable `BriefcaseDb`.
2. Select candidate element ids with a single ECSql query:
   `SELECT ECInstanceId FROM bis.GeometricElement3d WHERE GeometryStream IS NOT NULL AND length(GeometryStream) > :blobSize`.
3. If there are any candidates, acquire the exclusive schema lock (`acquireSchemaLock`) to
   lock the entire iModel before editing. This is a no-op for briefcases that do not use
   locks.
4. For each candidate, load its props with geometry (`wantGeometry`, `wantBRepData`):
   - Skip the element if it has no geometry, or if its `GeometryStream` already contains
     a part reference (`geomPart`). GeometryParts cannot be nested, so such a stream
     cannot be copied wholesale into a new part.
   - Insert a new `GeometryPart` (in the dictionary model, empty code) whose geometry is
     the element's `GeometryStream` verbatim. Because the part holds the geometry in the
     element's local coordinates, referencing it at the identity transform reproduces the
     original appearance.
   - Save the mapping between element and the part by saving the ids of both in a temporary table
5. `saveChanges`.
6. for each candidate, load its props:
   - Replace the element's `GeometryStream` with a single `appendGeometryPart3d(partId)`
     entry built via `GeometryStreamBuilder`, leaving placement and category unchanged,
     and update the element.  Use the mapping stored in step for to get the part id for this
     elements id.
7. `saveChanges`, then `vacuum` the iModel to reclaim the space freed by moving geometry
   out of the element rows.
8. Report the number of elements whose geometry stream was moved, parts created, and
   skipped.

## Idempotency

After conversion an element's `GeometryStream` is only a small part reference (well under
`--blob-size`), so re-running the command selects no rows and converts nothing. The
part-reference skip guard reinforces this for any element that already references a part.

The element-to-part mapping is held in a SQLite `TEMP` table, which is connection-local: it
is not part of the iModel's tracked changes (so it never enters a changeset) and is dropped
when the briefcase is closed. This keeps the scratch mapping out of the BIS data, consistent
with not editing the underlying tables directly.

Because the parts are committed (step 5) before any element is re-pointed (step 6), an
interruption between the two passes can leave committed `GeometryPart`s whose elements still
hold their full geometry. Re-running converts those elements again (the skip guard sees full
geometry, not a part reference) and creates fresh parts, orphaning the earlier ones; such
orphans are harmless but waste space until removed.
