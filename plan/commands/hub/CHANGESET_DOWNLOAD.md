# hub changeset download Command details

Implementation details for `imod hub changeset download metadata` and
`imod hub changeset download files`.

Changeset metadata can be downloaded using the iModels API:
https://developer.bentley.com/apis/imodels-v2/operations/get-imodel-changesets/

## Why two commands

Metadata and files cost wildly different amounts. Measured against a real 43,890 changeset
iModel:

| | cost |
| --- | --- |
| all metadata | 38s, ~19 MB of `imod.db` |
| all files | 21.06 GiB |

Holding the whole timeline's metadata is always affordable; downloading the whole timeline's
files rarely is. Splitting them lets the cache know about every changeset while holding the
files for only the ranges that are wanted.

## `download metadata`

Records changeset metadata in the cache's `changesets` table. Downloads no files.

- `--start` / `--end` are changeset indexes, **inclusive at both ends**. They map onto the
  hub's `afterIndex` (exclusive) and `lastIndex` (inclusive), so `--start 5` becomes
  `afterIndex: 4`.
- Pages at `$top: 1000`, the API maximum, writing each page as it arrives. Never buffers the
  whole history.
- Records the iModel's details too, so the cache can name what it holds.
- **Resumes.** With no range of its own it continues after the highest changeset already
  cached, and says so. A full history is hundreds of pages -- about seven minutes for half a
  million changesets -- so without this an interrupted run would start over. Changeset metadata
  never changes once pushed, so this is safe: the timeline only grows. `--start` is honoured
  exactly, a run with its own range never resumes, and `--refresh` fetches everything again.
- Progress is reported every tenth page rather than every page, which would be hundreds of
  lines on a large history.

Do not use `BackendIModelsAccess.queryChangesets` for this: it buffers every changeset through
`toArray` and pages at the API default of 100. On the 43,890 changeset iModel that measured
**233s against 38s** -- 439 round trips instead of 44.

## `download files`

Downloads the changeset files for a range into
`imodels/<iModelId>/changesets/<changesetId>.cs`, and records each file's path against its
changeset.

- Fetches the range's metadata first if the cache does not already hold it, since the metadata
  is what says which indexes exist and how big they are.
- Reports the range's size before transferring: `file_size` is already known, so the cost of a
  download is knowable without asking the hub.
- **Resumable by re-running.** The client skips any changeset whose file is present at the
  expected size, and re-fetches only what is missing or truncated. Verified against a real
  iModel: a repeat run left the file's mtime unchanged.
- **Downloaded in chunks of 1000**, not as one range. The client accumulates every changeset of
  the range it is given into a single array before returning (`ChangesetOperations.downloadList`,
  `result = result.concat(...)` per page), so a range of hundreds of thousands would be held at
  once and nothing recorded until all of it finished. Chunking bounds the memory and an
  interrupted download keeps what it already got. Each chunk's files are recorded in one
  transaction, which measured about 2.5x faster than a statement at a time.
- **Kept against iTwin.js's deletes.** Each downloaded file gets a second hard link in
  `imodels/<id>/changeset-cache/`, and that is the path the cache records. Anything that pulls
  deletes the copy in `changesets/`; unlinking that name leaves ours. Before downloading, any
  name iTwin.js removed is linked back so its skip still finds the file and nothing is fetched
  twice. See CACHE.md.

## Applying, later

`imod hub changeset apply` must **not** use `BriefcaseDb.pullChanges` or
`BriefcaseManager.pullAndApplyChangesets`. Both delete each changeset file after applying it
(`itwinjs-core/core/backend/src/BriefcaseManager.ts:494`), which would empty a cache that was
expensive to fill. Apply the cached files directly with
`db[_nativeDb].applyChangeset(props, false)` after opening with
`SnapshotDb.openForApplyChangesets`; verified against a real iModel, the cached files survive.

Two things that path must handle, both confirmed by testing:

- **`applyChangeset` is a silent no-op** when the changeset's parent is not the db's current
  changeset. It throws nothing and moves nothing. Every apply must re-read
  `nativeDb.getCurrentChangeset()` and fail if it did not advance.
- Applying requires a **read-write** open; `SnapshotDb.openFile` is read-only.
