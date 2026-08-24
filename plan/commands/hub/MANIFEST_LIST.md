# manifest list Command details

Implementation details for the `imod hub manifest list` command.

Lists the databases in the manifest file.

Details about the Cloud Backed SQLite can be found here: https://sqlite.org/cloudsqlite/doc/trunk/www/index.wiki

## Overview

The iModel is specified by one of these two parameters:

- `--imodel-id` - reads the manifest cached for that iModel, at
  `<cacheDir>/imodels/<imodelId>/manifest.bcv`. The manifest must already have been
  downloaded with `imod hub manifest download`; the command does not fetch one itself and
  makes no network calls.
- `--manifest-path` - reads the given manifest file instead, ignoring `--imodel-id`. Useful
  for inspecting a manifest that came from somewhere other than the cache.

Output is the path being read, a one-line summary of the manifest header, and a table with
one row per database.

## What is listed

| column | meaning |
| --- | --- |
| `database` | display name stored in the manifest |
| `id` | database id, 1 or greater |
| `parent` | id of the database this one was copied from; blank when it has none |
| `version` | database version |
| `blocks` | number of blocks making up the database |
| `state` | `deleted` for a database flagged as deleted, otherwise blank |

Deleted databases are explicitly listed as deleted.

`blocks` is a count, not a size. Multiplying it by the block size gives only an upper bound
on the database size, because the last block is usually partial and the manifest does not
record the true byte length.

> NOTE: The `list` command reads nothing beyond the manifest header, so it only needs the first `24 + 152 * nDb` bytes of the file. 
