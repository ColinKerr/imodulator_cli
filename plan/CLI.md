# CLI

The CLI tool is called `imod` as it short for imodulator.

## Root Level commands

- `imod auth` - Login to developer.bentley.com
- `imod hub` - Access all iModel Hub APIs e.g. create, clone, update, delete and download iModels
- `imod local` - Work with iModels that have already been downloaded from the hub
- `imod serve` - Run local servers
- `imod cache` - Control and view cached data
- `imod edit` - Commands that edit iModels creating local change sets that can be pushed to the hub
- `imod util` - Utility commands

## Hub commands

Commands under `imod hub`.

- `imod hub clone` - Clones the iModel specified by `--itwin-id` and `--imodel-id` to the iTwin specified by `--target-itwin-id` and outputs the iModel Id of the cloned iModel.
- `imod hub create` - Creates a new iModel in the iTwin specified by `--itwin-id`.  Optionally `--seed-file` can be used to specify the file path to a local iModel to use as a seed/template file for the new iModel.  Command outputs the iModel Id of the newly created iModel.

### briefcase

Commands to work with iModel briefcases used to edit an iModel.

- `imod hub briefcase acquire-id` - Acquires a new briefcase id from the hub for the iModel specified by the `--imodel-id` parameter.  Id is stored in cache.
- `imod hub briefcase list-id` - Lists all ids owned by user grouped by imodel-id or for a specific imodel-id if the `--imodel-id` is present.
- `imod hub briefcase release-id` - Releases the id specified by the `--imodel-id` and `--briefcase-id` parameters via the hub.  Released Ids are removed from the cache.
- `imod hub briefcase download` - Downloads a briefcase specified by the `--itwin-id`, `--imodel-id` and `--briefcase-id` parameters.  iModel briefcase is stored in the local cache directory
- `imod hub briefcase push` - Pushes any local changes to a briefcase specified by the `--imodel-id` and `--briefcase-id` parameters to the hub.

### checkpoint

Commands to work with iModel checkpoints used for read only tasks

- `imod hub checkpoint download` - Downloads the most recent checkpoint for the iModel specified by the `--itwin-id`, and `--imodel-id` parameters.  Alternatively `--url` can be set to a URL containing two GUIDs (the first the iTwin id, the second the iModel id), which replaces the `--itwin-id` and `--imodel-id` parameters.  Optionally `--changeset-id` can be used to specify the version of the checkpoint to download.

### manifest

Commands to work with Cloud Backed SQLite manifests for iModels.

- `imod hub manifest download` - Downloads the manifest for the iModel specified by the `--itwin-id` and `--imodel-id` parameters.  Alternatively `--url` can be set to a URL containing two GUIDs (the first the iTwin id, the second the iModel id), which replaces the `--itwin-id` and `--imodel-id` parameters.  If the manifest already exists the `--update` flag must be passed to download an updated copy.  See plan/commands/hub/MANIFEST_DOWNLOAD.md for more details.
- `imod hub manifest list` - Lists the databases in the manifest file for the iModel specified by the `--imodel-id` parameter.  Alternatively `--manifest-path` can be set to the path of a manifest file to read, which replaces the `--imodel-id` parameter.  Deleted databases are listed with a `deleted` marker.  See plan/commands/hub/MANIFEST_LIST.md for more details.

## Local commands

Commands under `imod local`

- `imod local clear` - clears the locally cached iModels specified by the `--imodel-id` parameter or optionally the `--briefcase-id` parameter or the `--changeset-id` parameter to specify a briefcase or specific checkpoint to clear respectively.

## Serve commands

Commands under `imod serve`

- `imod serve console` - Starts the eyeModel Console, a web app for writing ECSql queries against an iModel served by `imod serve backend`.  Optionally opens `--imodel-path` on load, listens on `--port` (default 8080), and `--stop` shuts it down.  See [CONSOLE.md](./commands/serve/CONSOLE.md).
- `imod serve backend` - Starts a local iTwin.js RPC backend that serves iModels from the cache or from a file path, then returns so other commands can run while it serves.  Optionally opens the iModel at `--imodel-path` under the key `default`, listens on `--port`, and `--stop` shuts a running server down.  See [BACKEND.md](./commands/serve/BACKEND.md).
- `imod serve stop-all` - Stops all running servers and reports back what was stopped.


## Cache commands

Commands under `imod cache`

- `imod cache dir` - Lists the cache directory
- `imod cache list-imodels` - lists all local iModels 
- `imod cache list-db` - lists contents of the cache db in formatted tables

## Edit commands

Commands under `imod edit`.  All Edit commands error if the iModel briefcase is not already downloaded.

- `imod edit import-schemas` - Imports schemas found at `--schema-path` into the iModel specified by `--imodel-id` and `--briefcase-id`.
- `imod edit partinate` - Partinates the briefcase specified by `--imodel-id` and `--briefcase-id` (see [PARTINATE.md](./commands/util/PARTINATE.md) for the `--blob-size` behavior), saving the moved geometry as local changes that `imod hub briefcase push` can push to the hub.
- `imod edit poke` - Updates the last mod date of the root model.
- `imod edit update-profile` - Updates teh iModels profile to the latest supported by iTwin.js.  Updates the iModel specified by `--imodel-id` and `--briefcase-id`.  Reuses the code from `imod util update-profile` but applies appropriate db lock.

## Transform commands

Commands under `imod transform`.  All Transform commands error if the iModel briefcase is not already downloaded.

- `imod transform unify-schemas` - Converts elements of classes from schemas specified by `--source-schemas` to elements of like named classes from `--target-schemas`.  The iModel to be transformed is specified by `--imodel-id` and `--briefcase-id`. 
- `imod transform using-map` - Converts elements of classes specified by the `--map-file` to the target class specified by that mapping file.  The `--dry_run` parameter generates a json output describing count of elements that would be transformed, grouped by source class instead of actually running the transform.  The iModel to be transformed is specified by `--imodel-id` and `--briefcase-id`.

## Util commands

Commands under `imod util`

- `imod util export-schemas` - Exports schemas from iModel specified by `--imodel-id` and `--briefcase-id` or `--imodel-id` and `--changeset-id` to directory specified by `--schema-path`.
- `imod util merge-schema-set` - Merges schemas from the set found in `--schema-path` whose schema alias match the regex input via `--alias` and outputs the resulting schemas in `--out-path`.  See ./commands/util/MERGE_SCHEMA_SET.md for more info.
- `imod util query` - Executes an ECSql query against the iModel specified by the `--imodel-path` argument.  Query loaded from the file specified by `--query-path`, query saved to the file specified by `--results-path` formatted as csv.  Query performance statistics (rows returned, CPU/total time, memory used, retries) are printed to the console after the query runs.
- `imod util partinate` - Modifies GeometricElement3D elements with GeometryStream properties greater than `--blob-size` so their geometry is stored in a GeometryPart instead of directly in the GeometryStream property on the element.  See ./commands/util/PARTINATE.md for more info.
- `imod util vacuum` - Opens the iModel specified by `--imodel-path` then closes it with optimize flag set to true.  Runs vacuum and analyze.
- `imod util set-fed-guids` - Sets all unset BisCore.Element.FederationGuid properties in the iModel specified by `--imodel-path`.
- `imod util update-profile` - Updates the iModels profile to the latest supported by iTwin.js. Updates iModel specified by `--imodel-path`.
- `imod util mapipulate` - Modifies mapping to move GeometryPart GeometryStreams into their own table.  Creates a new iModel based on the iModel specified by `--imodel-path`.  The flavor of mapping changes are controlled via the `--remap-type`.  See MAPIPULATE.md for details.

### Clean commands

Commands under `imod util clean`.  These commands cleanup drek in an iModel.

- `imod util clean esa` - Cleans duplicate ExternalSourceAspects from the imodel specified by the `--imodel-path` argument.  See [ESA.md](./commands/util/clean/ESA.md).
