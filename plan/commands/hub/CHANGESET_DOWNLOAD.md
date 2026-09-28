# hub changeset download Command details

Implementation details for `imod hub changeset download metadata` and
`imod hub changeset download files`.

Changeset metadata can be downloaded using the iModels API:
https://developer.bentley.com/apis/imodels-v2/operations/get-imodel-changesets/

Split into two commands so you can download the metadata to figure out which changesets you want to download.

## `download metadata`

Records changeset metadata in the cache's `changesets` table.

- `--start` / `--end` are changeset indexes, inclusive at both ends.
- Downloads in pages of 1000 changesets at a time.
- Re-run to resume a partial download.
- `--refresh` fetches all metadata again.

## `download files`

Downloads the changeset files for a range into `imodels/<iModelId>/changesets/<changesetId>.cs`, hard links a copy to `imodels/<iModelId>/changesets/` then records that path to the cache for the changeset.

- Fetches the range's metadata first if the cache does not already hold it.
- Re-run to resume where the last command left off.
- Downloads in pages of 1000 changesets at a time.
- Changesets are hard linked to `imodels/<id>/changeset-cache/` so a copy of the changeset survives iTwin.js applying the changeset.  Re-run the command to relink them into the iTwin.js changeset cache `imodels/<id>/changesets/`.  See CACHE.md.
