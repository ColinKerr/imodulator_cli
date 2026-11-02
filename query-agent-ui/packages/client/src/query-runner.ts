/**
 * Running ECSql on the host's iModel. Anything with `createQueryReader` will do: an
 * `IModelConnection` in a browser (the queries go to the backend by RPC), or an `IModelDb` in
 * Node. They are typed here by what is used, so this package depends on neither.
 */

import type { RunRawQuery } from "./caps";

/** The part of iTwin.js's `ECSqlReader` that the runner uses. */
export interface QueryReader {
  getMetaData(): Promise<{ name: string }[]>;
  step(): Promise<boolean>;
  readonly current: { toArray(): unknown[] };
}

/** An `IModelConnection` or an `IModelDb`. */
export interface QuerySource {
  createQueryReader(ecsql: string, params?: undefined, options?: { abbreviateBlobs?: boolean }): QueryReader;
}

/**
 * The query function the client runs the agent's queries with.
 *
 * - **Blobs are abbreviated.** One `GeometryStream` serialises to thousands of values, so one
 *   row could cost more than the whole budget, and the row cap cannot catch it.
 * - **A bad query throws before the first row**, when the reader reads its metadata, so the
 *   driver sends the error for the model to correct.
 * - **Short rows are padded with nulls.** `toArray()` drops trailing nulls, and a model reading
 *   `["Synchronization"]` under three columns guesses at the missing values.
 */
export function queryRunner(source: QuerySource): RunRawQuery {
  return async (ecsql) => {
    const reader = source.createQueryReader(ecsql, undefined, { abbreviateBlobs: true });
    const columns = (await reader.getMetaData()).map((column) => column.name);
    return {
      columns,
      rows: (async function* () {
        while (await reader.step()) {
          const row = reader.current.toArray();
          while (row.length < columns.length)
            row.push(null);
          yield row;
        }
      })(),
    };
  };
}
