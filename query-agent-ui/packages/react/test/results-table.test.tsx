// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { RESULT_PAGE_ROWS, ResultPages, type QueryPageOptions, type RawQueryResult } from "@query-agent/client";
import { MAX_SCROLL_HEIGHT, ResultsTable, ROW_HEIGHT } from "../src/ResultsTable";
import { mount, settle } from "./helpers";

const QUERY = "SELECT ECInstanceId, UserLabel FROM bis.Element";

/** An iModel with `total` rows for QUERY, honouring the reader's limit. Records the pages read. */
function paged(total: number) {
  const offsets: number[] = [];
  const runQuery = async (ecsql: string, page?: QueryPageOptions): Promise<RawQueryResult> => {
    if (ecsql.startsWith("SELECT COUNT(*)"))
      return { columns: ["n"], rows: (async function* () { yield [total]; })() };
    const start = page?.limit?.offset ?? 0;
    offsets.push(start);
    const end = Math.min(total, page?.limit ? start + page.limit.count : total);
    return { columns: ["ECInstanceId", "UserLabel"], rows: (async function* () { for (let i = start; i < end; i++) yield [`0x${(i + 1).toString(16)}`, `E${i + 1}`]; })() };
  };
  return { runQuery, offsets };
}

const bodyRows = (container: HTMLElement) => [...container.querySelectorAll("tbody tr:not(.qa-spacer)")];

describe("ResultsTable", () => {
  it("draws only the rows near the view, with the whole result's height, and the count", async () => {
    const { runQuery, offsets } = paged(1_465_576);
    const results = new ResultPages(runQuery, QUERY);
    const { container } = mount(<ResultsTable results={results} />);
    await settle();
    expect(container.querySelector(".qa-results-count")?.textContent).toBe(`${(1_465_576).toLocaleString()} rows`);
    const drawn = bodyRows(container);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThanOrEqual(80);
    expect(drawn[0].textContent).toBe("0x1E1");
    // The spacer below stands for the rows not drawn. This result is taller than a browser draws,
    // so the scroll bar is scaled to MAX_SCROLL_HEIGHT.
    const spacer = container.querySelector<HTMLElement>("tbody tr.qa-spacer:last-child");
    expect(Number.parseInt(spacer!.style.height, 10)).toBe(MAX_SCROLL_HEIGHT - drawn.length * ROW_HEIGHT);
    expect(offsets).toEqual([0]);
  });

  it("reads the page for the rows scrolled to, and draws them", async () => {
    const { runQuery, offsets } = paged(1_465_576);
    const results = new ResultPages(runQuery, QUERY);
    const { container } = mount(<ResultsTable results={results} />);
    await settle();
    const scroller = container.querySelector<HTMLDivElement>(".qa-results-scroll")!;
    // The scroll bar is scaled: the position for row 1,000,000 is that row's share of the height.
    const view = 40 * ROW_HEIGHT; // the rows assumed visible under jsdom
    const ratio = (1_465_576 * ROW_HEIGHT - view) / (MAX_SCROLL_HEIGHT - view);
    await act(async () => {
      scroller.scrollTop = (1_000_000 * ROW_HEIGHT) / ratio;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await settle();
    // The page holding row 1,000,000, whatever the page size.
    expect(offsets).toContain(Math.floor(1_000_000 / RESULT_PAGE_ROWS) * RESULT_PAGE_ROWS);
    expect(container.textContent).toContain("E1000001");
  });

  it("reaches the last row of a result far taller than a browser draws", async () => {
    const total = 3_464_225;
    const { runQuery } = paged(total);
    const results = new ResultPages(runQuery, QUERY);
    const { container } = mount(<ResultsTable results={results} />);
    await settle();
    const scroller = container.querySelector<HTMLDivElement>(".qa-results-scroll")!;
    await act(async () => {
      scroller.scrollTop = MAX_SCROLL_HEIGHT - 40 * ROW_HEIGHT;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await settle();
    const drawn = bodyRows(container);
    expect(drawn.at(-1)?.textContent).toBe(`0x${total.toString(16)}E${total}`);
    // The spacers and the drawn rows add up to the scaled height exactly, wherever the view is, so
    // redrawing never changes the content's height (which made the browser move the scroll position).
    const contentHeight = () => [...container.querySelectorAll<HTMLElement>("tbody tr.qa-spacer")]
      .map((tr) => Number.parseInt(tr.style.height, 10)).reduce((a, b) => a + b, 0) + bodyRows(container).length * ROW_HEIGHT;
    expect(contentHeight()).toBe(MAX_SCROLL_HEIGHT);
    // The last drawn row ends at the bottom of the view.
    const above = Number.parseInt(container.querySelector<HTMLElement>("tbody tr.qa-spacer")!.style.height, 10);
    expect(above + drawn.length * ROW_HEIGHT).toBe(MAX_SCROLL_HEIGHT);
    for (const position of [0, 1_234_567, MAX_SCROLL_HEIGHT / 2, MAX_SCROLL_HEIGHT - 40 * ROW_HEIGHT - 300]) {
      await act(async () => {
        scroller.scrollTop = position;
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(contentHeight()).toBe(MAX_SCROLL_HEIGHT);
    }
  });

  it("keeps the plain scroll bar for a result that fits", async () => {
    const { runQuery } = paged(1_000);
    const { container } = mount(<ResultsTable results={new ResultPages(runQuery, QUERY)} />);
    await settle();
    const spacer = container.querySelector<HTMLElement>("tbody tr.qa-spacer:last-child");
    expect(Number.parseInt(spacer!.style.height, 10)).toBe((1_000 - bodyRows(container).length) * ROW_HEIGHT);
  });

  it("shows the rows given when there are no pages", () => {
    const { container } = mount(<ResultsTable rows={{ columns: ["n"], rows: [[3]] }} />);
    expect(bodyRows(container).map((row) => row.textContent)).toEqual(["3"]);
    expect(container.querySelector(".qa-results-count")?.textContent).toBe("1 row");
  });

  it("says what went wrong", () => {
    const { container } = mount(<ResultsTable rows={{ error: "no such class" }} />);
    expect(container.textContent).toBe("no such class");
  });
});
