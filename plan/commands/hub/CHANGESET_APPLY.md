# hub changeset apply Command details

Implementation details for the `imod hub changeset apply` command.

Applies cached changesets to the iModel at `--imodel-path`, forwards, up to and including the
one named by `--changeset-id` or `--changeset-index`.

## It applies from the cache, and does not use pullChanges

`BriefcaseDb.pullChanges` and `BriefcaseManager.pullAndApplyChangesets` **delete each changeset
file once they have applied it** (`itwinjs-core/core/backend/src/BriefcaseManager.ts:494`). For a
cache that holds tens of gigabytes of changesets that is the wrong behaviour entirely, so this
opens the file and applies the cached ones itself:

- `SnapshotDb.openForApplyChangesets(path)` (`IModelDb.ts:4548`) for the read-write open.
  `SnapshotDb.openFile` is read-only and cannot apply.
- `nativeDb.applyChangeset(props, false)` per changeset, in index order.

Verified against a real iModel: after applying, every cached changeset file was still there.

## Every apply is checked

`applyChangeset` applies a changeset only when its parent is the db's current changeset. When it
is not, **it does nothing and throws nothing** -- confirmed against a real iModel, where applying
index 20 to a file at index 10 left it at 10 with no error. Every apply therefore re-reads
`nativeDb.getCurrentChangeset()` and fails if the index did not advance to the changeset just
applied. Without that check the command would report success having done nothing.

Two related checks:

- The whole span from the current index to the target must be present. A gap cannot be skipped,
  because each changeset applies only onto its own parent.
- A row whose recorded file is no longer on disk is **forgotten**, not just reported. Files go
  missing for a good reason: anything that has been through `pullChanges` -- an
  `imod hub checkpoint download` among them -- deletes the changesets it applied, leaving the
  cache claiming files it no longer has.

## Direction

Forward only. `applyChangeset` can reverse a changeset when the db sits exactly on it, but going
backwards is refused here with a message rather than attempted, so an accidental lower target
fails loudly instead of quietly rewinding an iModel.
