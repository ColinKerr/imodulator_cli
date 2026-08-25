import { describe, expect, it } from "vitest";
import {
  backEntries, canGoBack, canGoForward, emptyHistory, forwardEntries, jumpTo, remember,
  step, summarize, type QueryHistory,
} from "../../../web/src/query-history";

/** A history with the given queries run in order, sitting on the last one. */
const ran = (...queries: string[]): QueryHistory =>
  queries.reduce((history, query) => remember(history, query), emptyHistory());

describe("remember", () => {
  it("appends and moves to the new entry", () => {
    expect(ran("a", "b")).toEqual({ entries: ["a", "b"], at: 1 });
  });

  it("ignores re-running the entry already current", () => {
    // Otherwise pressing Run twice would leave Back with nowhere to go.
    expect(ran("a", "a")).toEqual({ entries: ["a"], at: 0 });
  });

  it("discards the entries ahead when a query is run after stepping back", () => {
    const history = step(ran("a", "b", "c"), -1); // sitting on "b"
    expect(remember(history, "d")).toEqual({ entries: ["a", "b", "d"], at: 2 });
  });

  it("records a query equal to one further back as a new entry", () => {
    // Only the *current* entry is deduped; "a" here is a genuine new point in history.
    expect(ran("a", "b", "a")).toEqual({ entries: ["a", "b", "a"], at: 2 });
  });
});

describe("navigation", () => {
  it("knows which directions are available", () => {
    const empty = emptyHistory();
    expect(canGoBack(empty)).toBe(false);
    expect(canGoForward(empty)).toBe(false);

    const atEnd = ran("a", "b");
    expect(canGoBack(atEnd)).toBe(true);
    expect(canGoForward(atEnd)).toBe(false);

    const atStart = step(atEnd, -1);
    expect(canGoBack(atStart)).toBe(false);
    expect(canGoForward(atStart)).toBe(true);
  });

  it("steps back and forward", () => {
    const history = ran("a", "b", "c");
    expect(step(history, -1).at).toBe(1);
    expect(step(step(history, -1), 1).at).toBe(2);
  });

  it("stays put at either end", () => {
    const history = ran("a");
    expect(step(history, -1)).toBe(history);
    expect(step(history, 1)).toBe(history);
  });

  it("jumps to an entry, and refuses one that does not exist", () => {
    const history = ran("a", "b", "c");
    expect(jumpTo(history, 0).at).toBe(0);
    expect(jumpTo(history, 9)).toBe(history);
    expect(jumpTo(history, -1)).toBe(history);
  });
});

describe("menus", () => {
  it("offers the entries behind, nearest first", () => {
    expect(backEntries(ran("a", "b", "c"))).toEqual([
      { at: 1, query: "b" },
      { at: 0, query: "a" },
    ]);
  });

  it("offers the entries ahead, nearest first", () => {
    const history = step(ran("a", "b", "c"), -2); // sitting on "a"
    expect(forwardEntries(history)).toEqual([
      { at: 1, query: "b" },
      { at: 2, query: "c" },
    ]);
  });

  it("offers nothing in a direction with no entries", () => {
    expect(backEntries(ran("a"))).toEqual([]);
    expect(forwardEntries(ran("a"))).toEqual([]);
    expect(backEntries(emptyHistory())).toEqual([]);
  });

  it("caps how many entries a menu offers", () => {
    const many = ran(...Array.from({ length: 30 }, (_, i) => `q${i}`));
    expect(backEntries(many)).toHaveLength(20);
    expect(backEntries(many, 5)).toHaveLength(5);
    // Nearest first, so the cap drops the oldest rather than the newest.
    expect(backEntries(many, 3).map((e) => e.query)).toEqual(["q28", "q27", "q26"]);
  });
});

describe("summarize", () => {
  it("collapses a formatted query onto one line", () => {
    expect(summarize("SELECT a\n  FROM bis.Element\n  WHERE x=1")).toBe("SELECT a FROM bis.Element WHERE x=1");
  });

  it("truncates a long query with an ellipsis", () => {
    expect(summarize("x".repeat(100)).length).toBe(80);
    expect(summarize("x".repeat(100)).endsWith("…")).toBe(true);
  });

  it("leaves a short query alone", () => {
    expect(summarize("SELECT 1")).toBe("SELECT 1");
  });
});
