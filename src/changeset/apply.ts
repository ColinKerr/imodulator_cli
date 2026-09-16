import * as fs from "node:fs";
import type { IModelDb } from "@itwin/core-backend";
import { _nativeDb } from "@itwin/core-backend/lib/cjs/internal/Symbols.js";
import {
  clearChangesetFile, iterateCachedChangesets, summarizeChangesets,
  type CachedChangeset, type ChangesetRange,
} from "../cache/changesets";

/**
 * Apply changesets that are already in the cache, forwards, to an open iModel.
 *
 * Deliberately *not* `BriefcaseDb.pullChanges` or `BriefcaseManager.pullAndApplyChangesets`.
 * Those download what they need and then delete each changeset file once it is applied
 * (`itwinjs-core/core/backend/src/BriefcaseManager.ts:494`), which would empty a cache that
 * cost tens of gigabytes to fill. Applying the cached files directly leaves them in place.
 *
 * The db must be open **read-write**: `SnapshotDb.openForApplyChangesets` is the open that
 * allows this, and `SnapshotDb.openFile` is not.
 */

export interface ApplyChangesetsResult {
  /** The changeset index the iModel was at before this ran. */
  fromIndex: number;
  /** The index it is at now. */
  toIndex: number;
  applied: number;
}

export interface ApplyChangesetsArgs {
  db: IModelDb;
  imodelId: string;
  /** Apply forwards up to and including this changeset index. */
  targetIndex: number;
  onApplied?: (changeset: CachedChangeset, appliedSoFar: number, total: number) => void;
}

/** Where the iModel currently sits in the timeline. */
export function currentChangesetIndex(db: IModelDb): number {
  return db[_nativeDb].getCurrentChangeset().index ?? 0;
}

export function applyCachedChangesets(args: ApplyChangesetsArgs): ApplyChangesetsResult {
  const { db, imodelId, targetIndex } = args;
  const nativeDb = db[_nativeDb];
  const fromIndex = currentChangesetIndex(db);

  if (targetIndex === fromIndex)
    return { fromIndex, toIndex: fromIndex, applied: 0 };
  if (targetIndex < fromIndex)
    throw new Error(
      `This iModel is already at changeset index ${fromIndex}, which is past ${targetIndex}. Reversing changesets is not supported; start from an earlier file.`,
    );

  const span: ChangesetRange = { start: fromIndex + 1, end: targetIndex };
  const total = summarizeChangesets(imodelId, span).count;
  if (total === 0)
    throw new Error(
      `No changesets cached for iModel ${imodelId} between ${fromIndex + 1} and ${targetIndex}. Run "imod hub changeset download files --imodel-id ${imodelId} --start ${fromIndex + 1} --end ${targetIndex}".`,
    );

  // Two streaming passes rather than one array: a span can run to hundreds of thousands of
  // changesets, and holding them all costs hundreds of megabytes for nothing. The first pass
  // checks, the second applies.
  //
  // Every changeset in the span must be present: a gap cannot be skipped, because each one
  // applies only onto its own parent.
  let missingCount = 0;
  let firstMissingIndex: number | undefined;
  const staleRows: number[] = [];
  for (const changeset of iterateCachedChangesets(imodelId, span)) {
    if (changeset.filePath !== undefined && fs.existsSync(changeset.filePath))
      continue;
    missingCount++;
    firstMissingIndex ??= changeset.index;
    // A recorded file that is no longer on disk means the cache is out of date -- iTwin.js
    // deletes changesets as it applies them, so anything that went through `pullChanges`, a
    // checkpoint download among them, will have taken some. Collected here and cleared after
    // the walk, rather than written to while the same query is still being read.
    if (changeset.filePath !== undefined)
      staleRows.push(changeset.index);
  }

  for (const index of staleRows)
    clearChangesetFile(imodelId, index);

  if (missingCount > 0)
    throw new Error(
      `${missingCount} changeset file(s) between ${fromIndex + 1} and ${targetIndex} are not downloaded, starting at index ${firstMissingIndex}. Run "imod hub changeset download files --imodel-id ${imodelId} --start ${fromIndex + 1} --end ${targetIndex}".`,
    );

  let applied = 0;
  for (const changeset of iterateCachedChangesets(imodelId, span)) {
    const before = currentChangesetIndex(db);
    nativeDb.applyChangeset(
      {
        id: changeset.id,
        index: changeset.index,
        parentId: changeset.parentId ?? "",
        changesType: changeset.containingChanges ?? 0,
        description: changeset.description ?? "",
        briefcaseId: changeset.briefcaseId ?? 0,
        pushDate: changeset.pushDateTime ?? "",
        userCreated: changeset.creatorId ?? "",
        size: changeset.fileSize,
        pathname: changeset.filePath!,
      },
      false,
    );

    // `applyChangeset` applies only when the changeset's parent is the current changeset, and
    // when it is not it returns quietly having done nothing -- no error, no movement. So the
    // only honest check that it worked is that the iModel actually moved.
    const after = currentChangesetIndex(db);
    if (after !== changeset.index)
      throw new Error(
        `Applying changeset ${changeset.id} (index ${changeset.index}) did nothing: the iModel is still at index ${before}. Its parent is ${changeset.parentId || "(none)"}, which does not match.`,
      );

    applied++;
    args.onApplied?.(changeset, applied, total);
  }

  nativeDb.saveChanges();
  return { fromIndex, toIndex: currentChangesetIndex(db), applied };
}
