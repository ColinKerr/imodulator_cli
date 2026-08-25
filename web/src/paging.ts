/**
 * Reading a query's rows a page at a time.
 *
 * The query reader holds the server side cursor and fetches the next page itself when its
 * local cache runs out, so paging is a matter of keeping one reader alive and stepping it
 * further -- never of re-running the query with an offset, which would repeat or skip rows
 * if the query is not fully ordered.
 */

/** The part of `ECSqlReader` this needs, so it can be driven by a stub in tests. */
export interface RowCursor {
  step(): Promise<boolean>;
  readonly current: { toArray(): unknown[] };
}

export interface Chunk {
  rows: unknown[][];
  /** True once the query has no more rows; the cursor is spent. */
  done: boolean;
}

/** Take up to `count` more rows, reporting whether the query ran out. */
export async function readChunk(cursor: RowCursor, count: number): Promise<Chunk> {
  const rows: unknown[][] = [];
  while (rows.length < count) {
    if (!(await cursor.step()))
      return { rows, done: true };
    rows.push(cursor.current.toArray());
  }
  return { rows, done: false };
}
