# Cache Documentation

The local cache is where `imod` keeps every iModel and changeset it has downloaded, plus a small SQLite index
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
      checkpoints/<iModelId>_<changesetId>.bim
      changesets/<changesetId>.cs            iTwin.js downloads here, and deletes as it applies
      changeset-cache/<changesetId>.cs       our hard link, which its deletes cannot touch
      manifest.bcv
```

### imodels directory

Most things under `imodels/` is managed by iTwin.js. `IModelHost.startup` is given our cache directory and iTwin.js defines `briefcases` and `changesets`.  

imodulator controls `changeset-cache`, `checkpoints`, and downloads `manifest.bcv`.

## imod.db

imod.db is the local cache where iModulator CLI keeps it's state.  This cache includes references
to all iModels and iModel related data downloaded by the CLI.

| Table | Key |
| --- | --- |
| `briefcase_ids` | (imodel_id, briefcase_id) |
| `downloaded_briefcases` | (imodel_id, briefcase_id) |
| `downloaded_checkpoints` | (imodel_id, changeset_id) |
| `downloaded_manifests` | imodel_id |
| `imodels` | imodel_id |
| `changesets` | (imodel_id, changeset_index) |
| `schema_version` | -- |

The cache stores absolute paths for each iModel in `file_path` and a `downloaded_at` default of `datetime('now')`.
`downloaded_manifests` also keeps the HTTP `etag`, which `hub manifest download` sends back as a conditional request so an unchanged manifest is not fetched twice.

The index only records what was downloaded via the CLI, it doesn't track changes to the 
filesystem made outside of the CLI.

`imod cache list db` dumps every table as a formatted table; `imod cache list imodels` presents
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

To run a second instance in another process set `IMOD_CACHE_DIR` to a different directory.  See `plan/TESTING.md` for an example of this.

`imod.db` itself is WAL and would tolerate multiple readers; the iTwin.js profile lock is the binding
constraint, not SQLite.
