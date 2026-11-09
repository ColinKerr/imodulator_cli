/**
 * An answer's results as a virtualized table, with no row limit.
 *
 * Only the rows in view (and a few either side) are drawn: the rows above and below are two spacer
 * rows of the right height, so the scroll bar is the whole result's. A result taller than
 * `MAX_SCROLL_HEIGHT` gets a scaled scroll bar. The rows come from the run's
 * `ResultPages`, which reads them a page at a time through the query reader as the table scrolls.
 * Without one (a host that gives rows only), the rows given are shown.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import type { AnswerRows, ResultPages } from "@query-agent/client";

/** The height of one row, in pixels: `.qa-results td` in `styles.css` keeps rows to one line of it. */
export const ROW_HEIGHT = 22;
/** Rows drawn beyond the view on each side, so a short scroll shows rows already drawn. */
const OVERSCAN = 20;
/**
 * The tallest the scrolled content is made, in pixels. Browsers stop drawing taller elements
 * (Chrome near 33.5 million pixels, Firefox near 17.9 million), which at 22px a row is about 1.5
 * million rows in Chrome. Past this the scroll bar is scaled, so every row can still be reached.
 */
export const MAX_SCROLL_HEIGHT = 15_000_000;
/** The rows assumed visible before the table has been measured (and under jsdom, which has no layout). */
const DEFAULT_VISIBLE = 40;

function cellText(value: unknown): string {
  return value === null || value === undefined ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** The table's rows: from pages when there are pages, else from the rows given. */
interface RowSource {
  columns: string[];
  count: number;
  /** The count is a lower bound: more rows may follow. */
  more: boolean;
  row(index: number): unknown[] | undefined;
  error?: string;
}

function sourceOf(rows: AnswerRows | undefined, results: ResultPages | undefined): RowSource | undefined {
  if (results) {
    // Until the pages arrive, the rows the client first read stand in for them.
    const firstRows = rows?.error === undefined ? rows?.rows ?? [] : [];
    return {
      columns: results.columns ?? rows?.columns ?? [],
      count: results.count ?? Math.max(results.atLeast, firstRows.length),
      more: results.count === undefined,
      row: (index) => results.row(index) ?? firstRows[index],
      error: results.error,
    };
  }
  if (!rows || rows.error !== undefined)
    return undefined;
  const list = rows.rows ?? [];
  return { columns: rows.columns ?? [], count: list.length, more: rows.truncatedBy !== undefined, row: (index) => list[index] };
}

export function ResultsTable(props: { rows?: AnswerRows; results?: ResultPages }): JSX.Element {
  const { rows, results } = props;
  const [, changed] = useReducer((n: number) => n + 1, 0);
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const header = useRef<HTMLTableSectionElement>(null);
  // The height the rows can use: the scroller's, less the header that stays at its top.
  const [viewPx, setViewPx] = useState(DEFAULT_VISIBLE * ROW_HEIGHT);

  useEffect(() => results?.subscribe(changed), [results]);
  useEffect(() => {
    setTop(0);
    if (scroller.current)
      scroller.current.scrollTop = 0;
  }, [results, rows]);
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined")
      return;
    const measure = () => setViewPx(element.clientHeight > 0
      ? Math.max(ROW_HEIGHT, element.clientHeight - (header.current?.offsetHeight ?? 0))
      : DEFAULT_VISIBLE * ROW_HEIGHT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const source = sourceOf(rows, results);
  // With pages and no rows read yet, the count is 0: ask for the first rows to learn more.
  const knownCount = source?.count ?? 0;
  // Past MAX_SCROLL_HEIGHT the scroll bar is scaled: a scroll position stands for a row further on.
  // The scroll position runs from 0 to height - viewPx; it stands for 0 to full - viewPx in rows.
  const full = knownCount * ROW_HEIGHT;
  const height = Math.min(full, MAX_SCROLL_HEIGHT);
  const visible = Math.ceil(viewPx / ROW_HEIGHT) + 1;
  const ratio = full > height && height > viewPx ? (full - viewPx) / (height - viewPx) : 1;
  const virtualTop = Math.min(top * ratio, Math.max(0, full - viewPx));
  const firstInView = Math.floor(virtualTop / ROW_HEIGHT);
  const first = Math.max(0, firstInView - OVERSCAN);
  const last = Math.min(source?.more ? Math.max(knownCount, first + visible + 2 * OVERSCAN) : knownCount, firstInView + visible + OVERSCAN);
  useEffect(() => {
    results?.want(first, last);
  }, [results, first, last]);

  if (rows?.error !== undefined)
    return <div className="qa-error">{rows.error}</div>;
  if (!source)
    return <div className="qa-muted">No results yet.</div>;

  const drawn: JSX.Element[] = [];
  for (let index = first; index < Math.min(last, knownCount); index++) {
    const row = source.row(index);
    drawn.push(
      <tr key={index} style={{ height: ROW_HEIGHT }}>
        {source.columns.map((_, c) => <td key={c}>{row ? cellText(row[c]) : ""}</td>)}
      </tr>,
    );
  }
  // The drawn rows sit where the view is: their first visible row at the top of the view.
  // In both cases the spacers and the drawn rows add up to `height` exactly, so the content never
  // changes height as the rows are redrawn (which made the browser move the scroll position).
  const drawnPx = drawn.length * ROW_HEIGHT;
  const above = ratio === 1
    ? first * ROW_HEIGHT
    : Math.round(Math.min(Math.max(0, top - (virtualTop - first * ROW_HEIGHT)), Math.max(0, height - drawnPx)));
  const below = Math.max(0, height - above - drawnPx);
  const counted = source.more ? `${knownCount.toLocaleString()}+ rows` : `${knownCount.toLocaleString()} ${knownCount === 1 ? "row" : "rows"}`;

  return (
    <div className="qa-results">
      <div className="qa-results-count qa-muted">{source.error ? `Could not read more rows: ${source.error}` : counted}</div>
      <div className="qa-results-scroll" ref={scroller} onScroll={(event) => setTop(event.currentTarget.scrollTop)}>
        <table>
          <thead ref={header}><tr>{source.columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead>
          <tbody>
            {above > 0 && <tr className="qa-spacer" style={{ height: above }} />}
            {drawn}
            {below > 0 && <tr className="qa-spacer" style={{ height: below }} />}
          </tbody>
        </table>
      </div>
    </div>
  );
}
