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

## The index: `imod.db`

`src/cache/cache-db.ts` opens `<cache>/imod.db` with better-sqlite3 in WAL mode, creates the
schema if it is absent, and memoises the handle for the life of the process. It is opened lazily,
on first use, so a command that never touches the cache never creates the file.

| Table | Key | Written by | Read by |
| --- | --- | --- | --- |
| `briefcase_ids` | (imodel_id, briefcase_id) | `hub briefcase acquire-id`, deleted by `release-id` | **nothing** |
| `downloaded_briefcases` | (imodel_id, briefcase_id) | `hub briefcase download` | `cache list-imodels`, `local clear`, `serve` key resolution |
| `downloaded_checkpoints` | (imodel_id, changeset_id) | `hub checkpoint download` | as above |
| `downloaded_manifests` | imodel_id | `hub manifest download` | `hub manifest download` (etag), `hub manifest list` |

Every table stores an absolute `file_path` and a `downloaded_at` default of `datetime('now')`.
`downloaded_manifests` also keeps the HTTP `etag`, which `hub manifest download` sends back as a
conditional request so an unchanged manifest is not fetched twice.

The index records **what was downloaded, not what exists**. Nothing reconciles it against the
file system except `local clear`, which removes both together.

`imod cache list-db` dumps every table as a formatted table; `imod cache list-imodels` presents
the briefcase and checkpoint rows grouped by iModel.

## Schema

This is the tracked definition of the cache database. `initSchema` in `src/cache/cache-db.ts` is
the implementation of it; the two change together, and a change to either is a change to the
design. It is reproduced verbatim below rather than summarised, so a diff of this file shows
exactly what moved.

```sql
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
- **No explicit indexes.** The only four are SQLite's automatic primary-key indexes
  (`sqlite_autoindex_*`). Every lookup the code performs is by full primary key --
  `resolveIModelKey` queries `(imodel_id, briefcase_id)` and `(imodel_id, changeset_id)` -- so it
  hits those. `cache list-imodels` and `cache list-db` scan, which is fine at this row count.
- **No foreign keys**, so a `downloaded_briefcases` row does not require a `briefcase_ids` row.
- **`file_path` is absolute**, and is the value iTwin.js reported for the downloaded file rather
  than one the CLI composed.
- **Timestamps are text**, from SQLite's `datetime('now')`, so they are UTC to the second.

### Changing the schema

The mechanism today is `CREATE TABLE IF NOT EXISTS`, run on every open. `PRAGMA user_version` has
never been set; it reads **0**, as does `application_id`.

That mechanism carries exactly one safe change: **adding a new table**, which appears on existing
caches at the next open. Anything else does not take effect and does not complain. Adding a column
to a table that already exists is silently skipped -- confirmed rather than assumed:

```
$ sqlite3 probe.db "CREATE TABLE IF NOT EXISTS t (a TEXT NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a,b));"
$ sqlite3 probe.db "CREATE TABLE IF NOT EXISTS t (a TEXT NOT NULL, b INTEGER NOT NULL, c TEXT, PRIMARY KEY (a,b));"
  no error raised
  columns now: a b
```

So a new column, a changed primary key, a new index or a dropped column all need a migration, and
until one exists such a change must not be made by editing the DDL above alone -- every cache in
the wild would keep the old shape while the code assumed the new one.

When that day comes, the pieces are: stamp `PRAGMA user_version` with a schema number, keep the
statements above as the definition of version *n*, and apply ordered migrations from whatever
version the file reports. `user_version = 0` today means "created before versioning", which is a
usable starting point: the current shape can simply be declared version 1.

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
