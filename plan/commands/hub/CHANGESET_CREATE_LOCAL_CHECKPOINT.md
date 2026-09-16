# hub changeset create-local-checkpoint Command details

Implementation details for the `imod hub changeset create-local-checkpoint` command.

Creates a checkpoint file at `--changeset-id` or `--changeset-index` by copying an earlier local
file and applying cached changesets to it.

## The recipe

The same one iTwin.js uses for this job in `CheckpointManager.updateToRequestedVersion`
(`itwinjs-core/core/backend/src/CheckpointManager.ts:315-340`):

1. copy the base file to the target path
2. `deleteAllTxns()` if the file has any pending
3. `resetBriefcaseId(BriefcaseIdValue.Unassigned)` -- this is what makes it a checkpoint rather
   than a briefcase, not where it came from
4. apply changesets forward to the target
5. `saveChanges()`

The one difference is step 4: iTwin.js downloads the changesets and deletes them as it applies,
this applies the ones already cached and leaves them alone. See CHANGESET_APPLY.md.

## Choosing the base

`--base-path` names a file explicitly. Otherwise `findBase` takes the closest local file at or
before the target, considering both cached checkpoints and cached briefcases -- either is a valid
starting point. Closest matters: a checkpoint at index 40,000 makes a checkpoint at 40,010 cost
ten changesets rather than forty thousand.

A briefcase's or checkpoint's changeset id resolves to an index through the `changesets` table,
so the metadata for the iModel must be cached first. An empty changeset id means the state before
any changeset, which is index 0.

## Failure leaves nothing behind

A half-applied checkpoint is worse than none: it is a valid iModel file sitting at the wrong
changeset, and nothing about it says so. If applying fails the partial file is deleted rather
than left to be found later.

The finished checkpoint is recorded in `downloaded_checkpoints`, so `imod serve`, `local clear`
and a later `create-local-checkpoint` can all find it.
