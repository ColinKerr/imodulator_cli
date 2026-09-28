# hub changeset create-local-checkpoint Command details

Implementation details for the `imod hub changeset create-local-checkpoint` command.

Creates a checkpoint file at `--changeset-id` or `--changeset-index` by copying an earlier local
file and applying cached changesets to it.

`--base-path` names a starting iModel if nothing is specified the closest local file at or
before the target is used, cached checkpoints and cached briefcases are scanned.

The changesets and metadata for the iModel must already be downloaded via the `imod hub changeset download` command.

If the changesets fail to apply the wip imodel is deleted.

The finished checkpoint is recorded in `downloaded_checkpoints`, so `imod serve`, `local clear`
and a later `create-local-checkpoint` can all find it.

## The recipe

The same one iTwin.js uses for this job in `CheckpointManager.updateToRequestedVersion`:

1. copy the base file to the target path
2. `deleteAllTxns()` if the file has any pending
3. `resetBriefcaseId(BriefcaseIdValue.Unassigned)` -- this is what makes it a checkpoint rather
   than a briefcase, not where it came from
4. apply changesets forward to the target
5. `saveChanges()`

One important difference is step 4: iTwin.js downloads the changesets and deletes them as it applies,
this applies the ones already cached and leaves them alone. See CHANGESET_APPLY.md.
