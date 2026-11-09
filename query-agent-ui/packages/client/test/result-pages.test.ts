import { describe, expect, it } from "vitest";
import type { QueryPageOptions, RunRawQuery } from "../src/caps";
import { ResultPages } from "../src/result-pages";
import { rows } from "./helpers";

const QUERY = "SELECT ECInstanceId, UserLabel FROM bis.Element";

/** An iModel with `total` rows for QUERY, honouring the reader's limit, and a count over it. Records each read. */
function paged(total: number, options: { countFails?: boolean } = {}): RunRawQuery & { asked: { ecsql: string; page?: QueryPageOptions }[] } {
  const all = Array.from({ length: total }, (_, i) => [`0x${(i + 1).toString(16)}`, `E${i + 1}`]);
  const asked: { ecsql: string; page?: QueryPageOptions }[] = [];
  const run = (async (ecsql: string, page?: QueryPageOptions) => {
    asked.push({ ecsql, ...(page ? { page } : {}) });
    if (ecsql === `SELECT COUNT(*) FROM (${QUERY})`) {
      if (options.countFails)
        throw new Error("cannot count");
      return rows(["n"], [[total]]);
    }
    if (ecsql.replace(/;$/, "") !== QUERY)
      throw new Error(`no such query: ${ecsql}`);
    const start = page?.limit?.offset ?? 0;
    const end = page?.limit ? start + page.limit.count : total;
    return rows(["ECInstanceId", "UserLabel"], all.slice(start, end));
  }) as RunRawQuery & { asked: { ecsql: string; page?: QueryPageOptions }[] };
  run.asked = asked;
  return run;
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

describe("ResultPages", () => {
  it("reads only the pages asked for, with the reader's limit, and the count once", async () => {
    const runQuery = paged(1_465_576);
    const pages = new ResultPages(runQuery, QUERY, undefined, 500);
    pages.want(1_000_000, 1_000_060);
    await settle();
    expect(pages.count).toBe(1_465_576);
    expect(pages.row(1_000_000)).toEqual(["0xf4241", "E1000001"]);
    expect(pages.row(0)).toBeUndefined();
    const reads = runQuery.asked.filter((q) => q.ecsql === QUERY);
    expect(reads.map((q) => q.page?.limit)).toEqual([{ offset: 1_000_000, count: 500 }]);
    expect(runQuery.asked.filter((q) => q.ecsql.startsWith("SELECT COUNT(*)"))).toHaveLength(1);
  });

  it("keeps read pages, so scrolling back reads nothing", async () => {
    const runQuery = paged(2_000);
    const pages = new ResultPages(runQuery, QUERY, undefined, 500);
    pages.want(0, 600);
    await settle();
    pages.want(0, 100);
    await settle();
    expect(runQuery.asked.filter((q) => q.ecsql === QUERY).map((q) => q.page?.limit?.offset)).toEqual([0, 500]);
  });

  it("follows the latest rows asked for, not every page a fast scroll passed", async () => {
    const runQuery = paged(100_000);
    const pages = new ResultPages(runQuery, QUERY, undefined, 500);
    pages.want(0, 50);
    pages.want(10_000, 10_050);
    pages.want(90_000, 90_050);
    await settle();
    const offsets = runQuery.asked.filter((q) => q.ecsql === QUERY).map((q) => q.page?.limit?.offset);
    expect(offsets).toContain(90_000);
    expect(offsets).not.toContain(10_000);
  });

  it("starts from the rows already read: all of them when complete, with no query", async () => {
    const runQuery = paged(3);
    const pages = new ResultPages(runQuery, QUERY, { columns: ["ECInstanceId", "UserLabel"], rows: [["0x1", "E1"], ["0x2", "E2"], ["0x3", "E3"]], complete: true });
    pages.want(0, 40);
    await settle();
    expect(pages.count).toBe(3);
    expect(pages.row(2)).toEqual(["0x3", "E3"]);
    expect(runQuery.asked).toEqual([]);
  });

  it("finds the end from a short page when the query cannot be counted", async () => {
    const runQuery = paged(700, { countFails: true });
    const pages = new ResultPages(runQuery, QUERY, undefined, 500);
    expect(pages.atLeast).toBe(0);
    pages.want(0, 1_000);
    await settle();
    expect(pages.count).toBe(700);
    expect(pages.row(699)).toEqual(["0x2bc", "E700"]);
  });

  it("counts a query that ends in a semicolon", async () => {
    const runQuery = paged(42);
    const pages = new ResultPages(runQuery, `${QUERY};`, undefined, 10);
    pages.want(0, 5);
    await settle();
    expect(runQuery.asked.map((q) => q.ecsql)).toContain(`SELECT COUNT(*) FROM (${QUERY})`);
    expect(pages.count).toBe(42);
  });

  it("keeps a failing query's error, and tells its listeners", async () => {
    const pages = new ResultPages(paged(10), "SELECT broken", undefined, 500);
    let told = 0;
    pages.subscribe(() => told++);
    pages.want(0, 40);
    await settle();
    expect(pages.error).toBe("no such query: SELECT broken");
    expect(told).toBeGreaterThan(0);
  });

  it("writes out as its query and count, not its rows", async () => {
    const pages = new ResultPages(paged(3), QUERY, { columns: ["a"], rows: [[1], [2], [3]], complete: true });
    expect(JSON.parse(JSON.stringify({ results: pages }))).toEqual({ results: { ecsql: QUERY, count: 3 } });
  });
});
