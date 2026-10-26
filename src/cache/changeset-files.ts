import * as fs from "node:fs";
import * as path from "node:path";
import { BriefcaseManager } from "@itwin/core-backend";
import { ensureIModelCacheDir } from "./cache-dir";
import {
  cachedChangesetById, clearChangesetFiles, iterateCachedChangesets, iterateRecordedChangesetFiles,
  recordChangesetFiles, type ChangesetRange,
} from "./changesets";

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

/** What `repairChangesetFiles` found and did for one iModel. */
export interface ChangesetRepairResult {
  imodelId: string;
  /** Files in the keep directory, plus any adopted from iTwin.js's directory. */
  filesOnDisk: number;
  /** Files whose row now points at them and did not before. */
  recorded: number;
  /** Files in iTwin.js's directory with no kept name, given one. */
  adopted: number;
  /** Names put back in iTwin.js's directory. */
  relinked: number;
  /** Rows whose recorded file no longer exists, and are now marked as not downloaded. */
  cleared: number;
  /** Files whose changeset id has no cached metadata, so nothing can be recorded for them. */
  unknown: string[];
  /** Files whose size does not match the metadata: partial or corrupt. Left on disk, not recorded. */
  wrongSize: string[];
}

/** `<id>.cs` files in a directory, as changeset id to path. A missing directory holds none. */
function changesetFilesIn(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names)
    if (name.endsWith(".cs"))
      files.set(name.slice(0, -".cs".length), path.join(dir, name));
  return files;
}

/** Changeset ids among the files on disk that the cache has no metadata for. */
export function unknownChangesetIds(imodelId: string): string[] {
  const ids = new Set([
    ...changesetFilesIn(changesetKeepDir(imodelId)).keys(),
    ...changesetFilesIn(BriefcaseManager.getChangeSetsPath(imodelId)).keys(),
  ]);
  return [...ids].filter((id) => cachedChangesetById(imodelId, id) === undefined);
}

/**
 * Make the cache and the disk agree about one iModel's changeset files, without the network.
 *
 * - every file in the keep directory whose size matches its metadata is recorded against it;
 * - a file in iTwin.js's directory with no kept name is adopted, when its size matches (a size
 *   that does not is an interrupted download, which the client would delete anyway);
 * - each kept file gets its name back in iTwin.js's directory, so a download or a pull skips it;
 * - a row whose recorded file is gone is marked as not downloaded.
 *
 * The only files removed are ones a complete file replaces: a different copy under the same name
 * in iTwin.js's directory, or a wrong-size kept file when iTwin.js's directory holds a complete
 * one. A wrong-size file with nothing to replace it is left alone and reported. Needs a started
 * host, for iTwin.js's directory.
 */
export function repairChangesetFiles(imodelId: string): ChangesetRepairResult {
  const keepDir = changesetKeepDir(imodelId);
  const workDir = BriefcaseManager.getChangeSetsPath(imodelId);
  const kept = changesetFilesIn(keepDir);
  const working = changesetFilesIn(workDir);
  const result: ChangesetRepairResult = {
    imodelId, filesOnDisk: 0, recorded: 0, adopted: 0, relinked: 0, cleared: 0, unknown: [], wrongSize: [],
  };

  const toRecord: { changesetIndex: number; filePath: string }[] = [];
  const ids = new Set([...kept.keys(), ...working.keys()]);
  for (const id of ids) {
    const changeset = cachedChangesetById(imodelId, id);
    if (changeset === undefined) {
      result.unknown.push(id);
      continue;
    }

    let keepPath = kept.get(id);
    if (keepPath === undefined || fs.statSync(keepPath).size !== changeset.fileSize) {
      // Nothing usable kept: a complete file in iTwin.js's directory can stand in for it.
      const workPath = working.get(id);
      if (workPath === undefined || fs.statSync(workPath).size !== changeset.fileSize) {
        result.wrongSize.push(id);
        continue;
      }
      keepPath = keepChangesetFile(imodelId, id, workPath);
      result.adopted++;
    }
    result.filesOnDisk++;

    const workPath = path.join(workDir, changesetFileName(id));
    const work = fs.statSync(workPath, { throwIfNoEntry: false });
    if (work === undefined || work.ino !== fs.statSync(keepPath).ino) {
      // A different file under that name is the wrong size or a stale copy; ours replaces it.
      fs.mkdirSync(workDir, { recursive: true });
      fs.rmSync(workPath, { force: true });
      fs.linkSync(keepPath, workPath);
      result.relinked++;
    }

    if (changeset.filePath !== keepPath)
      toRecord.push({ changesetIndex: changeset.index, filePath: keepPath });
  }
  recordChangesetFiles(imodelId, toRecord);
  result.recorded = toRecord.length;

  const gone: number[] = [];
  for (const changeset of iterateRecordedChangesetFiles(imodelId))
    if (!fs.existsSync(changeset.filePath!))
      gone.push(changeset.index);
  clearChangesetFiles(imodelId, gone);
  result.cleared = gone.length;

  return result;
}
