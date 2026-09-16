import { getCacheDb } from "./cache-db";

/**
 * Changeset metadata held in the cache, and where the file is when one has been downloaded.
 *
 * Metadata and files are cached separately: a 43,890 changeset iModel's whole history is ~7 MB
 * of rows against 21 GiB of files, so most rows have no file and never will.
 */
export interface CachedChangeset {
  index: number;
  id: string;
  parentId?: string;
  description?: string;
  pushDateTime?: string;
  briefcaseId?: number;
  /** Size of the changeset file in bytes, from the API. Known before the file is fetched. */
  fileSize: number;
  containingChanges?: number;
  state?: string;
  groupId?: string;
  creatorId?: string;
  /** Where the downloaded file is, or undefined when only the metadata is held. */
  filePath?: string;
  downloadedAt?: string;
}

/** A range of changeset indexes, inclusive at both ends, as the hub's own range is. */
export interface ChangesetRange {
  start?: number;
  end?: number;
}

interface ChangesetRow {
  changeset_index: number;
  changeset_id: string;
  parent_id: string | null;
  description: string | null;
  push_date_time: string | null;
  briefcase_id: number | null;
  file_size: number;
  containing_changes: number | null;
  state: string | null;
  group_id: string | null;
  creator_id: string | null;
  file_path: string | null;
  downloaded_at: string | null;
}

function toCachedChangeset(row: ChangesetRow): CachedChangeset {
  return {
    index: row.changeset_index,
    id: row.changeset_id,
    parentId: row.parent_id ?? undefined,
    description: row.description ?? undefined,
    pushDateTime: row.push_date_time ?? undefined,
    briefcaseId: row.briefcase_id ?? undefined,
    fileSize: row.file_size,
    containingChanges: row.containing_changes ?? undefined,
    state: row.state ?? undefined,
    groupId: row.group_id ?? undefined,
    creatorId: row.creator_id ?? undefined,
    filePath: row.file_path ?? undefined,
    downloadedAt: row.downloaded_at ?? undefined,
  };
}

/**
 * Record changeset metadata, leaving any file already recorded alone.
 *
 * Metadata is refetched whole rather than diffed, so this runs for changesets whose file is
 * already downloaded. `file_path` and `downloaded_at` are preserved rather than overwritten
 * with nulls, which is why this is an upsert of the metadata columns only.
 *
 * Written in one transaction: at 43,890 rows, a statement per row without one is the
 * difference between a second and a minute.
 */
export function upsertChangesetMetadata(imodelId: string, changesets: CachedChangeset[]): void {
  const db = getCacheDb();
  const statement = db.prepare(
    `INSERT INTO changesets (
       imodel_id, changeset_index, changeset_id, parent_id, description, push_date_time,
       briefcase_id, file_size, containing_changes, state, group_id, creator_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (imodel_id, changeset_index) DO UPDATE SET
       changeset_id = excluded.changeset_id,
       parent_id = excluded.parent_id,
       description = excluded.description,
       push_date_time = excluded.push_date_time,
       briefcase_id = excluded.briefcase_id,
       file_size = excluded.file_size,
       containing_changes = excluded.containing_changes,
       state = excluded.state,
       group_id = excluded.group_id,
       creator_id = excluded.creator_id`,
  );

  db.transaction(() => {
    for (const changeset of changesets)
      statement.run(
        imodelId,
        changeset.index,
        changeset.id,
        changeset.parentId ?? null,
        changeset.description ?? null,
        changeset.pushDateTime ?? null,
        changeset.briefcaseId ?? null,
        changeset.fileSize,
        changeset.containingChanges ?? null,
        changeset.state ?? null,
        changeset.groupId ?? null,
        changeset.creatorId ?? null,
      );
  })();
}

/** Record that a changeset's file is now on disk. */
export function recordChangesetFile(imodelId: string, changesetIndex: number, filePath: string): void {
  getCacheDb()
    .prepare(
      `UPDATE changesets SET file_path = ?, downloaded_at = datetime('now')
       WHERE imodel_id = ? AND changeset_index = ?`,
    )
    .run(filePath, imodelId, changesetIndex);
}

/**
 * Record many changesets' files in one transaction.
 *
 * A statement at a time costs about 2.5x as much -- measured, 118ms against 48ms per 10,000 --
 * because each one is its own implicit transaction.
 */
export function recordChangesetFiles(
  imodelId: string,
  files: { changesetIndex: number; filePath: string }[],
): void {
  const db = getCacheDb();
  const statement = db.prepare(
    `UPDATE changesets SET file_path = ?, downloaded_at = datetime('now')
     WHERE imodel_id = ? AND changeset_index = ?`,
  );
  db.transaction(() => {
    for (const file of files)
      statement.run(file.filePath, imodelId, file.changesetIndex);
  })();
}

/** Forget a changeset's file without forgetting the changeset. */
export function clearChangesetFile(imodelId: string, changesetIndex: number): void {
  getCacheDb()
    .prepare(
      `UPDATE changesets SET file_path = NULL, downloaded_at = NULL
       WHERE imodel_id = ? AND changeset_index = ?`,
    )
    .run(imodelId, changesetIndex);
}

/** The SQL fragment and parameters for an inclusive index range. */
function rangeClause(imodelId: string, range: ChangesetRange): { where: string; params: unknown[] } {
  const params: unknown[] = [imodelId];
  let where = "imodel_id = ?";
  if (range.start !== undefined) {
    where += " AND changeset_index >= ?";
    params.push(range.start);
  }
  if (range.end !== undefined) {
    where += " AND changeset_index <= ?";
    params.push(range.end);
  }
  return { where, params };
}

/**
 * Cached changesets in index order, one at a time.
 *
 * An iModel can hold hundreds of thousands of changesets, and holding a range of that size as
 * objects costs hundreds of megabytes -- measured, 500,000 rows is about 410 MiB. Anything
 * that walks changesets rather than needing them all at once should use this.
 */
export function* iterateCachedChangesets(
  imodelId: string,
  range: ChangesetRange = {},
): Generator<CachedChangeset> {
  const { where, params } = rangeClause(imodelId, range);
  const statement = getCacheDb().prepare(`SELECT * FROM changesets WHERE ${where} ORDER BY changeset_index`);
  for (const row of statement.iterate(...params))
    yield toCachedChangeset(row as ChangesetRow);
}

export interface ListChangesetsOptions {
  /** At most this many rows. Without one, every changeset in the range is materialised. */
  limit?: number;
}

/**
 * Cached changesets in index order as an array.
 *
 * Prefer `iterateCachedChangesets` unless the range is known to be small or a `limit` is given:
 * this holds every row it returns.
 */
export function listCachedChangesets(
  imodelId: string,
  range: ChangesetRange = {},
  options: ListChangesetsOptions = {},
): CachedChangeset[] {
  const { where, params } = rangeClause(imodelId, range);
  const limit = options.limit === undefined ? "" : ` LIMIT ${Number(options.limit)}`;
  const rows = getCacheDb()
    .prepare(`SELECT * FROM changesets WHERE ${where} ORDER BY changeset_index${limit}`)
    .all(...params) as ChangesetRow[];
  return rows.map(toCachedChangeset);
}

export interface ChangesetSummary {
  /** Changesets whose metadata is cached. */
  count: number;
  /** Of those, how many have their file on disk. */
  withFile: number;
  /** Total bytes of every changeset in the range, downloaded or not. */
  totalBytes: number;
  /** Bytes still to fetch, which is what a download of this range would transfer. */
  missingBytes: number;
  minIndex?: number;
  maxIndex?: number;
}

/**
 * What a range holds and what downloading it would cost.
 *
 * `file_size` comes from the API with the metadata, so this answers "how big is this download"
 * without asking the hub anything.
 */
export function summarizeChangesets(imodelId: string, range: ChangesetRange = {}): ChangesetSummary {
  const { where, params } = rangeClause(imodelId, range);
  const row = getCacheDb()
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(file_path IS NOT NULL), 0) AS withFile,
              COALESCE(SUM(file_size), 0) AS totalBytes,
              COALESCE(SUM(CASE WHEN file_path IS NULL THEN file_size ELSE 0 END), 0) AS missingBytes,
              MIN(changeset_index) AS minIndex,
              MAX(changeset_index) AS maxIndex
       FROM changesets WHERE ${where}`,
    )
    .get(...params) as {
      count: number; withFile: number; totalBytes: number; missingBytes: number;
      minIndex: number | null; maxIndex: number | null;
    };
  return {
    count: row.count,
    withFile: row.withFile,
    totalBytes: row.totalBytes,
    missingBytes: row.missingBytes,
    minIndex: row.minIndex ?? undefined,
    maxIndex: row.maxIndex ?? undefined,
  };
}

/** The index of a changeset named by its id, when the cache knows it. */
export function changesetIndexForId(imodelId: string, changesetId: string): number | undefined {
  const row = getCacheDb()
    .prepare("SELECT changeset_index FROM changesets WHERE imodel_id = ? AND changeset_id = ?")
    .get(imodelId, changesetId) as { changeset_index: number } | undefined;
  return row?.changeset_index;
}

/** The highest index whose metadata is cached, which is where a metadata sync resumes from. */
export function highestCachedIndex(imodelId: string): number | undefined {
  const row = getCacheDb()
    .prepare("SELECT MAX(changeset_index) AS maxIndex FROM changesets WHERE imodel_id = ?")
    .get(imodelId) as { maxIndex: number | null };
  return row.maxIndex ?? undefined;
}
