# hub changeset apply Command details

Implementation details for the `imod hub changeset apply` command.

Applies cached changesets to the iModel at `--imodel-path`, forwards, up to and including the
one named by `--changeset-id` or `--changeset-index`.  Returns an error if the specified changest has an index lower than the iModel's current changeset index.

## Changeset apply strategy

Avoids `BriefcaseDb.pullChanges` and `BriefcaseManager.pullAndApplyChangesets` to avoid pulling remote changesets or deleting local copies after apply.  Uses `nativeDb.applyChangeset` instead.

Fails if the changeset silently doesn't apply, hard failures during apply are not caught and end the process.
