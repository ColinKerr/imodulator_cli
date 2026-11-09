/**
 * An answer's results with no row limit, read a page at a time for a virtualized table.
 *
 * Each page is its own read through the iTwin.js query reader, with the reader's `limit` option
 * (`QueryPageOptions`), which is how the reader pages internally too: every page it reads is a
 * request with an offset and a count. Nothing here rewrites the query. The total is read once,
 * with `SELECT COUNT(*)` over the query, as the iTwin.js tests count a paged result; until it is
 * known, or when the query cannot be counted that way, the rows read so far are the lower bound.
 *
 * Pages are read one at a time, for the rows the table last asked for: a fast scroll does not queue
 * up every page it passed. Read pages are kept, so scrolling back costs nothing.
 */

import type { RawQueryResult, RunRawQuery } from "./caps";

/** How many rows one page reads. */
export const RESULT_PAGE_ROWS = 1000;

/** Rows already read, which the results start from: the answer's rows as the client first read them. */
export interface FirstRows {
  columns: string[];
  rows: unknown[][];
  /** The first rows are all the rows. */
  complete: boolean;
}

/** The query with any trailing semicolons removed, so it can be counted inside `FROM (...)`. */
function bare(ecsql: string): string {
  return ecsql.trim().replace(/;+\s*$/, "").trim();
}

async function readAll(result: RawQueryResult): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  for await (const row of result.rows)
    rows.push(row);
  return rows;
}

export class ResultPages {
  private readonly pages = new Map<number, unknown[][]>();
  private readonly listeners = new Set<() => void>();
  private _columns: string[] | undefined;
  private _count: number | undefined;
  private _error: string | undefined;
  /** The highest row index known to exist, plus one: the lower bound while the count is unknown. */
  private _known = 0;
  private wanted: { start: number; end: number } | undefined;
  private loading = false;
  private counting: Promise<void> | undefined;

  public constructor(private readonly runQuery: RunRawQuery, public readonly ecsql: string,
    first?: FirstRows, public readonly pageRows = RESULT_PAGE_ROWS) {
    if (first) {
      this._columns = first.columns;
      // The first rows fill page 0 only when they are a whole page or all the rows.
      if (first.complete || first.rows.length >= pageRows) {
        this.pages.set(0, first.rows.slice(0, pageRows));
        this._known = Math.min(first.rows.length, pageRows);
      }
      if (first.complete)
        this._count = first.rows.length;
    }
  }

  /** What a run carrying this says of it when written out as JSON: the query and the count, not the rows. */
  public toJSON(): { ecsql: string; count?: number } {
    return { ecsql: this.ecsql, ...(this._count !== undefined ? { count: this._count } : {}) };
  }

  /** The column names, once the first page (or the first rows) has been read. */
  public get columns(): string[] | undefined {
    return this._columns;
  }

  /** The number of rows, when known. */
  public get count(): number | undefined {
    return this._count;
  }

  /** How many rows there are at least: the count when known, else the rows found so far. */
  public get atLeast(): number {
    return this._count ?? this._known;
  }

  /** The error the query gave, if a page failed. */
  public get error(): string | undefined {
    return this._error;
  }

  /** A row, if its page has been read. */
  public row(index: number): unknown[] | undefined {
    return this.pages.get(Math.floor(index / this.pageRows))?.[index % this.pageRows];
  }

  /** Called whenever a page, the count or an error arrives. Returns a function that stops it. */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Ask for the rows from `start` up to `end`: their pages are read, one at a time, unless a later
   * call asks for other rows first. The count is read alongside the first call.
   */
  public want(start: number, end: number): void {
    this.wanted = { start: Math.max(0, start), end: Math.max(start, end) };
    if (this._count === undefined && !this.counting)
      this.counting = this.readCount();
    if (!this.loading)
      void this.loadWanted();
  }

  /** Read every page up to `end` rows (all of them when undefined): for a host or a test. */
  public async loadUpTo(end?: number): Promise<void> {
    for (let page = 0; ; page++) {
      const start = page * this.pageRows;
      if ((end !== undefined && start >= end) || (this._count !== undefined && start >= this._count))
        return;
      const rows = await this.readPage(page);
      if (rows === undefined || rows.length < this.pageRows)
        return;
    }
  }

  private notify(): void {
    for (const listener of this.listeners)
      listener();
  }

  private async readCount(): Promise<void> {
    try {
      const result = await this.runQuery(`SELECT COUNT(*) FROM (${bare(this.ecsql)})`);
      const [row] = await readAll(result);
      const count = Number(row?.[0]);
      if (Number.isFinite(count) && count >= 0) {
        this._count = count;
        this.notify();
      }
    } catch {
      // Some queries cannot be wrapped (a CTE, for one): the end is found when a page comes back short.
    }
  }

  /** The next page the wanted rows need that has not been read, or undefined. */
  private nextWantedPage(): number | undefined {
    if (!this.wanted || this._error !== undefined)
      return undefined;
    const last = this._count !== undefined ? Math.min(this.wanted.end, this._count) : this.wanted.end;
    for (let page = Math.floor(this.wanted.start / this.pageRows); page * this.pageRows < last; page++) {
      if (!this.pages.has(page))
        return page;
    }
    return undefined;
  }

  private async loadWanted(): Promise<void> {
    this.loading = true;
    try {
      for (let page = this.nextWantedPage(); page !== undefined; page = this.nextWantedPage()) {
        const rows = await this.readPage(page);
        // A failed page stops the reading; a short one is the last.
        if (rows === undefined || rows.length < this.pageRows)
          break;
      }
    } finally {
      this.loading = false;
    }
  }

  /** Read one page (or return it, read before); undefined when the query failed. */
  private async readPage(page: number): Promise<unknown[][] | undefined> {
    const cached = this.pages.get(page);
    if (cached)
      return cached;
    try {
      const result = await this.runQuery(this.ecsql, { limit: { offset: page * this.pageRows, count: this.pageRows } });
      const rows = await readAll(result);
      this._columns ??= result.columns;
      this.pages.set(page, rows);
      this._known = Math.max(this._known, page * this.pageRows + rows.length);
      // A short page is the last: the count is now known, whether or not COUNT(*) could run.
      if (rows.length < this.pageRows && this._count === undefined)
        this._count = page * this.pageRows + rows.length;
      this.notify();
      return rows;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this.notify();
      return undefined;
    }
  }
}
