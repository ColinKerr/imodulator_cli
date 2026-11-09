/**
 * Reading a query's rows up to the caps the function sends: the client's half of the row format.
 *
 * The function writes the text the model sees from these rows. The two halves must agree exactly,
 * so the rules here are the turn API's.
 */

import type { QueryRows, ResultCaps } from "./turn-api";

/**
 * One query's results, streamed, so the reader can stop once a cap is reached: nothing should
 * read two million rows to find that only the first two hundred were wanted.
 *
 * The runner that builds this **must** abbreviate blobs (`abbreviateBlobs` on the reader).
 */
export interface RawQueryResult {
  columns: string[];
  rows: AsyncIterable<unknown[]>;
}

/**
 * Which rows of a result to read, passed to the iTwin.js query reader as its own options
 * (`QueryOptions.limit` and `restartToken`): the reader asks the backend for exactly these rows,
 * so a page of a large result is read without reading the rows before it.
 */
export interface QueryPageOptions {
  /** The rows to read: `count` rows from `offset`. */
  limit?: { offset: number; count: number };
  /** A newer query with the same token cancels this one (the reader's `restartToken`). */
  restartToken?: string;
}

export type RunRawQuery = (ecsql: string, page?: QueryPageOptions) => Promise<RawQueryResult>;

/** A string cut to the cap, as the function will show it: used only to measure the line. */
function asShown(value: unknown, maxCellChars: number): unknown {
  if (typeof value !== "string" || value.length <= maxCellChars)
    return value;
  return `${value.slice(0, maxCellChars)}…[clipped, ${value.length} chars]`;
}

/**
 * Read a result up to the caps:
 *
 * 1. stop before a row once there are `maxRows` rows (`truncatedBy: "rows"`);
 * 2. stop before a row whose line would take the total past `maxChars` (`truncatedBy: "chars"`),
 *    but always keep the first row. A line is the row as a JSON array, with each long string as
 *    the function will show it, plus one character; the total starts at the length of
 *    `columns: ` and the column names as a JSON array;
 * 3. cut each string to `maxCellChars`, and add `[row, column, full length]` to `clipped`.
 */
export async function readCapped(result: RawQueryResult, caps: ResultCaps): Promise<Pick<QueryRows, "columns" | "rows" | "clipped" | "truncatedBy">> {
  let chars = `columns: ${JSON.stringify(result.columns)}`.length;
  const rows: unknown[][] = [];
  const clipped: [number, number, number][] = [];
  let truncatedBy: "rows" | "chars" | undefined;
  for await (const row of result.rows) {
    if (rows.length >= caps.maxRows) {
      truncatedBy = "rows";
      break;
    }
    const line = JSON.stringify(row.map((value) => asShown(value, caps.maxCellChars)));
    if (chars + line.length + 1 > caps.maxChars && rows.length > 0) {
      truncatedBy = "chars";
      break;
    }
    rows.push(row.map((value, column) => {
      if (typeof value !== "string" || value.length <= caps.maxCellChars)
        return value;
      clipped.push([rows.length, column, value.length]);
      return value.slice(0, caps.maxCellChars);
    }));
    chars += line.length + 1;
  }
  return { columns: result.columns, rows, ...(clipped.length > 0 ? { clipped } : {}), ...(truncatedBy ? { truncatedBy } : {}) };
}
