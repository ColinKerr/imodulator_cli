# Cache Documentation

The local cache is where `imod` keeps every iModel it has downloaded, plus a small SQLite index
describing what those files are. It is the only state the CLI keeps between runs.

## Where it is

`getCacheDir()` in `src/cache/cache-dir.ts` resolves it, in order:

1. `IMOD_CACHE_DIR`, if set and non-empty
2. `~/.imod/cache`

The environment variable is read on **every call**, not captured at startup, so a process can be
pointed at a different cache by its environment alone. That is how the tests isolate themselves
(`src/test/temp-workspace.ts`) and how a spawned `imod serve` inherits the cache of whatever
started it.

`imod cache dir` prints the resolved path.

## Layout on disk

```
<cache>/
  imod.db                       the index, described below
  imod.db-wal, imod.db-shm      SQLite WAL sidecars
  serve-backend.json            running server record  ─┐ written by src/serve/server-process.ts
  serve-backend.log             that server's output    │
  serve-console.json            "                       │
  serve-console.log             "                      ─┘
  profiles/default/             IModelHost workspace, incl. CloudCaches
  imodels/
    <iModelId>/
      briefcases/<briefcaseId>.bim        + -wal, -shm, -locks sidecars
      changesets/                         downloaded changesets
      checkpoints/<iModelId>_<changesetId>.bim
      changesets/<changesetId>.cs            iTwin.js downloads here, and deletes as it applies
      changeset-cache/<changesetId>.cs       our hard link, which its deletes cannot touch
      manifest.bcv
```

### imodels directory

Most things under `imodels/` is managed by iTwin.js. `IModelHost.startup` is given
our cache directory and calls `BriefcaseManager.initialize(join(cacheDir, "imodels"))`
(`itwinjs-core/core/backend/src/IModelHost.ts:654`). `BriefcaseManager` then decides
`<iModelId>/` (`getIModelPath`), `briefcases/` (`getBriefcaseBasePath`), `changesets/`
(`getChangeSetsPath`), and the `<briefcaseId>.bim` file name (`getFileName`). The iModulator 
asks for a download and records where the file landed. `profiles/` is likewise
IModelHost's.

What the CLI does place itself, via `ensureIModelCacheDir()`:

- `checkpoints/<iModelId>_<changesetId>.bim` (`src/commands/hub/checkpoint/download.ts`)
- `manifest.bcv` (`src/commands/hub/manifest/download.ts`)

Both sit *inside* iTwin.js's per-iModel directory, alongside directories iTwin.js manages.

## imod.db

imod.db is the local cache with iModulator CLI keeps it's state.  This cache includes references
to all iModels and iModel related data downloaded by the CLI.

| Table | Key | Written by | Read by |
| --- | --- | --- | --- |
| `briefcase_ids` | (imodel_id, briefcase_id) | `hub briefcase acquire-id`, deleted by `release-id` | **nothing** |
| `downloaded_briefcases` | (imodel_id, briefcase_id) | `hub briefcase download` | `cache list-imodels`, `local clear`, `serve` key resolution |
| `downloaded_checkpoints` | (imodel_id, changeset_id) | `hub checkpoint download` | as above |
| `downloaded_manifests` | imodel_id | `hub manifest download` | `hub manifest download` (etag), `hub manifest list` |
| `imodels` | imodel_id | `hub briefcase download`, `hub checkpoint download`, `hub create`, `hub briefcase acquire-id`, `cache update` | `cache list-imodels`, `resolveCheckpointTarget` |
| `changesets` | (imodel_id, changeset_index) | `hub changeset download metadata`, `hub changeset download files` | `cache list changesets`, `hub changeset download files` |
| `schema_version` | -- | `migrateCacheDb` | `migrateCacheDb` |

The cache stores absolute paths for each iModel in `file_path` and a `downloaded_at` default of
`datetime('now')`.
`downloaded_manifests` also keeps the HTTP `etag`, which `hub manifest download` sends back as a
conditional request so an unchanged manifest is not fetched twice.

The index only records what was downloaded via the CLI, it doesn't track changes to the 
filesystem made outside of the CLI.

`imod cache list-db` dumps every table as a formatted table; `imod cache list-imodels` presents
the briefcase and checkpoint rows grouped by iModel, with each iModel's name when `imodels` has
it.

### iModel details

The `imodels` table holds iModel Id, iTwin Id, Name, Display Name and Description about each 
iModel stored in the cache.  It is automatically filled when a hub command accesses the iModel, 
and be directly updated using `imod cache update`.

## Schema

This is the tracked definition of the cache database, at **version 2**. `MIGRATIONS` in
`src/cache/schema.ts` is the implementation of it; the two change together, and a change to
either is a change to the design. It is reproduced verbatim below rather than summarized, so a
diff of this file shows exactly what moved.

```sql
CREATE TABLE IF NOT EXISTS imodels (
  imodel_id TEXT NOT NULL PRIMARY KEY,
  itwin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT
);

CREATE INDEX IF NOT EXISTS ix_imodels_itwin ON imodels (itwin_id);

CREATE TABLE IF NOT EXISTS changesets (
  imodel_id TEXT NOT NULL,
  changeset_index INTEGER NOT NULL,
  changeset_id TEXT NOT NULL,
  parent_id TEXT,
  description TEXT,
  push_date_time TEXT,
  briefcase_id INTEGER,
  file_size INTEGER NOT NULL,
  containing_changes INTEGER,
  state TEXT,
  group_id TEXT,
  creator_id TEXT,
  file_path TEXT,
  downloaded_at TEXT,
  PRIMARY KEY (imodel_id, changeset_index)
);

CREATE INDEX IF NOT EXISTS ix_changesets_id ON changesets (imodel_id, changeset_id);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS briefcase_ids (
  imodel_id TEXT NOT NULL,
  briefcase_id INTEGER NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (imodel_id, briefcase_id)
);

CREATE TABLE IF NOT EXISTS downloaded_briefcases (
  imodel_id TEXT NOT NULL,
  briefcase_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  changeset_id TEXT,
  downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (imodel_id, briefcase_id)
);

CREATE TABLE IF NOT EXISTS downloaded_checkpoints (
  imodel_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (imodel_id, changeset_id)
);

CREATE TABLE IF NOT EXISTS downloaded_manifests (
  imodel_id TEXT NOT NULL PRIMARY KEY,
  file_path TEXT NOT NULL,
  etag TEXT,
  downloaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Notes:

- **`journal_mode = WAL`**, set on every open.
- **One explicit index**, `ix_imodels_itwin`, for finding an iTwin's iModels; everything else
  relies on SQLite's automatic primary-key indexes (`sqlite_autoindex_*`). Every lookup the code
  performs is by full primary key -- `resolveIModelKey` queries `(imodel_id, briefcase_id)` and
  `(imodel_id, changeset_id)`, and `imodels` is keyed on `imodel_id` alone precisely because that
  is what the other tables reference. `cache list-imodels` and `cache list-db` scan, which is fine
  at this row count.
- **No foreign keys**, so a `downloaded_briefcases` row does not require a `briefcase_ids` row.
- **`file_path` is absolute**, and is the value iTwin.js reported for the downloaded file rather
  than one the CLI composed.
- **Timestamps are text**, from SQLite's `datetime('now')`, so they are UTC to the second.

### Versioning

The version lives in the `schema_version` table, holding one row, absence of this table indicates 
schema version 1.

`migrateCacheDb` in `src/cache/schema.ts` runs on every open and resolves the state from what is
present, never from a sentinel value:

| `sqlite_master` holds | Meaning | Action |
| --- | --- | --- |
| nothing | an empty file: no schema, so no version | create at the current version |
| the original tables, no `schema_version` | the unversioned schema, i.e. version 1 | migrate forward |
| `schema_version` | exactly the version it names | migrate forward if behind, fail if ahead |

Each version is applied in its own `IMMEDIATE` transaction so upgrades are atomic.

### Version history

| Version | Added |
| --- | --- |
| 1 | `briefcase_ids`, `downloaded_briefcases`, `downloaded_checkpoints`, `downloaded_manifests`. The original schema, which predates versioning and is recognised by the absence of a stamp. |
| 2 | `imodels` and `changesets`, their indexes, and `schema_version` itself. |

Every version has a fixture under `src/test/cache/fixtures/vN.sql`, and a test builds each one,
upgrades it, and asserts the result is indistinguishable from a cache created fresh at the
current version. Adding a version without a fixture fails that suite, which is what keeps older
caches upgradeable as versions accumulate.

## Concurrency

**One process at a time per cache directory.** `IModelHost.startup` takes an exclusive lock on the
workspace profile in `profiles/default`, so a second process using the same cache fails with:

```
Db is busy: Profile [<cache>/profiles/default] is already in use by another process
```

This is a real constraint, not a theoretical one: a running `imod serve backend` locks out any
other `imod` command sharing that cache. Working around it means pointing the other process at a
different `IMOD_CACHE_DIR` — which is exactly what the test suite does, giving every test process
its own cache so files can run in parallel (see `plan/TESTING.md`).

`imod.db` itself is WAL and would tolerate multiple readers; the profile lock is the binding
constraint, not SQLite.

## Changesets

Metadata and files are cached separately, because metadata is small and changesets are large.

So the whole timeline is always affordable to hold, and files are fetched by range. `file_size`
arrives with the metadata, which is what lets `download files` and `cache list changesets` say
what a range costs *before* transferring it.

- **`file_path IS NULL`** is the normal state: it means the changeset is known but its file has
  not been fetched. It is the "do I have this" test, and `SUM(file_size) WHERE file_path IS NULL`
  is what a download would still transfer.
- **Metadata is refetched whole**, never diffed, so `upsertChangesetMetadata` updates only the
  metadata columns. Overwriting `file_path` with null on a re-sync would lose track of gigabytes
  already on disk.
- **No download URL is cached.** `_links.download` is a short-lived SAS URL that the client
  refetches per attempt; storing it would cache an expired link.
- **Re-downloading a range is cheap.** The client skips a changeset whose file exists at the
  expected size, and re-fetches only what is missing or truncated, so an interrupted download
  resumes by being run again. Verified: a repeat left the file's mtime unchanged.
- Files land in iTwin.js's own `imodels/<iModelId>/changesets/<changesetId>.cs`.

Paging matters at this scale. `hub changeset download metadata` pages the iModels API at
`$top: 1000` and writes each page as it arrives. The obvious alternative,
`BackendIModelsAccess.queryChangesets`, buffers every changeset through `toArray` and pages at
the API default of 100: measured on the same iModel it took **233s against 38s**, 439 round
trips instead of 44.

### Preserving ChangeSets

Anything that goes through `BriefcaseDb.pullChanges` deletes each changeset file once it has
applied it (`itwinjs-core/core/backend/src/BriefcaseManager.ts:494`). `imod hub checkpoint
download` is one of those things: downloading a checkpoint at changeset 5 applies changesets 1-5
and deletes those files. Observed against a real iModel -- ten changesets downloaded, a
checkpoint taken at index 5, and files 1-5 were gone afterwards.

So a downloaded changeset gets a **second hard link** in `imodels/<id>/changeset-cache/`, a
directory iTwin.js does not know about, and that is the name the cache records. Deleting a name
unlinks that name; the file lives as long as any name remains. One inode, two names, no extra
disk. Verified live: ten changesets downloaded, a checkpoint taken at index 5, and all ten were
still there afterwards -- iTwin.js's own directory dropped to five.

Downloads still go into iTwin.js's `changesets/` directory rather than straight into the keep
directory, because the client skips a changeset whose file is already there at the expected
size, so a pull reuses what this CLI downloaded instead of fetching it again.
`restoreChangesetFiles` links the name back after iTwin.js has removed it, which is what keeps
that saving: re-running a download of a range a checkpoint consumed reports
`Restored 5 changeset file(s) already held` and transfers nothing.

A `file_path` is still a claim rather than a guarantee -- a file can be removed by hand -- so
`applyCachedChangesets` checks each file exists before applying and clears the rows whose files
have gone.

### Reading changesets at scale

An iModel can hold hundreds of thousands of changesets, and the read paths were measured
against a seeded cache of 500,000:

| | before | after |
| --- | --- | --- |
| `cache list changesets`, no range | 954 MiB resident, a 48.6 MiB table | 62ms, 19 KiB, 200 rows of 500,000 |
| walking a whole range | 410 MiB held as objects | 279ms, no growth |
| the count `download files` needs | 400ms + 410 MiB | 60ms, no allocation |
| recording 10,000 files | 118ms | 19ms |

What that cost, and how:

- **`iterateCachedChangesets` streams**; `listCachedChangesets` still materialises and now takes
  a `limit`. Anything that walks changesets rather than needing them all at once iterates:
  `restoreChangesetFiles`, `applyCachedChangesets` (two streaming passes, one to check and one
  to apply), and the `--downloaded-only` listing, which stops once the limit is filled.
- **`cache list changesets` shows a window**, 200 rows by default, with the totals still
  describing the whole range and a footer saying what was left out. `--limit 0` prints
  everything.
- **Counts come from `summarizeChangesets`**, an aggregate, rather than from materialising a
  range and taking its length.
- **Files are recorded in one transaction per chunk** rather than a statement at a time.

The write path needed nothing: inserting 500,000 rows in pages of 1000 takes 1.3s, and the
aggregates answer in 60ms off the primary key. The cost is 325 bytes a row -- 155 MB for one
iModel's full history -- which is what makes `cache list db` omitting this table load-bearing
rather than a nicety.
