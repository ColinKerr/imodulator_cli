import * as fs from "node:fs";
import * as path from "node:path";
import { BriefcaseManager } from "@itwin/core-backend";
import { ensureIModelCacheDir } from "./cache-dir";
import { iterateCachedChangesets, type ChangesetRange } from "./changesets";

/**
 * Keeping downloaded changesets, against iTwin.js deleting them.
 *
 * iTwin.js deletes each changeset file once it has applied it
 * (`itwinjs-core/core/backend/src/BriefcaseManager.ts:494`), from the directory it owns,
 * `imodels/<id>/changesets`. Anything that pulls goes through that -- `imod hub checkpoint
 * download` among them -- so changesets this CLI downloaded on purpose disappear as a side
 * effect of an unrelated command. Observed: ten changesets downloaded, a checkpoint taken at
 * index 5, and files 1-5 were gone.
 *
 * So a downloaded changeset gets a **second hard link** in a directory iTwin.js does not know
 * about. Deleting a name unlinks that name; the file itself lives as long as any name remains,
 * so iTwin.js removing its own copy leaves ours untouched. One inode, two names, no extra disk.
 *
 * Downloading still happens into iTwin.js's directory rather than ours, because the client
 * skips a changeset whose file is already there at the expected size -- so a pull reuses what
 * this CLI downloaded instead of fetching it again. `restoreChangesetFiles` puts that name back
 * after iTwin.js has removed it, which is what keeps that saving.
 */

/** Where kept changesets live. iTwin.js never looks in here. */
export function changesetKeepDir(imodelId: string): string {
  return path.join(ensureIModelCacheDir(imodelId), "changeset-cache");
}

/** The name iTwin.js uses for a changeset file, which is also the name used in the keep dir. */
export function changesetFileName(changesetId: string): string {
  return `${changesetId}.cs`;
}

/**
 * Give a downloaded changeset a second name in the keep directory, and return that name.
 *
 * The keep path is what the cache records, so nothing downstream depends on the copy iTwin.js
 * may delete.
 */
export function keepChangesetFile(imodelId: string, changesetId: string, downloadedPath: string): string {
  const keepDir = changesetKeepDir(imodelId);
  fs.mkdirSync(keepDir, { recursive: true });
  const keepPath = path.join(keepDir, changesetFileName(changesetId));

  // One stat rather than an existsSync and a stat: this runs per changeset, and a large
  // download is hundreds of thousands of them.
  const kept = fs.statSync(keepPath, { throwIfNoEntry: false });
  if (kept !== undefined) {
    // Already kept. Same inode means the same file, and there is nothing to do; a different
    // one means a stale keep, which the fresh download replaces.
    if (kept.ino === fs.statSync(downloadedPath).ino)
      return keepPath;
    fs.rmSync(keepPath, { force: true });
  }

  fs.linkSync(downloadedPath, keepPath);
  return keepPath;
}

/**
 * Put back the names iTwin.js deleted, for changesets still held in the keep directory.
 *
 * Called before a download so the client's skip finds them and fetches nothing. Without this,
 * every changeset consumed by a checkpoint download would be fetched again the next time the
 * range was asked for, which for a large iModel is gigabytes.
 */
export function restoreChangesetFiles(imodelId: string, range: ChangesetRange = {}): number {
  const workDir = BriefcaseManager.getChangeSetsPath(imodelId);
  let restored = 0;

  // Iterated rather than listed: this looks at one changeset at a time, and a range can run to
  // hundreds of thousands.
  for (const changeset of iterateCachedChangesets(imodelId, range)) {
    if (changeset.filePath === undefined || !fs.existsSync(changeset.filePath))
      continue;
    const workPath = path.join(workDir, changesetFileName(changeset.id));
    if (fs.existsSync(workPath))
      continue;
    fs.mkdirSync(workDir, { recursive: true });
    fs.linkSync(changeset.filePath, workPath);
    restored++;
  }

  return restored;
}
