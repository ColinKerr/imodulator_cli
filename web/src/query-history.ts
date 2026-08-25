/**
 * The console's query history.
 *
 * Kept apart from the DOM so the index arithmetic can be tested: it is the sort of code that
 * looks obviously right and quietly does the wrong thing.
 *
 * Behaves like a browser's session history. Running a query after stepping back discards the
 * entries ahead, because that branch is no longer reachable from where the user is.
 */
export interface QueryHistory {
  entries: string[];
  /** Index of the entry the console is showing; -1 before anything has run. */
  at: number;
}

/** How many entries a history menu offers. */
export const MENU_LIMIT = 20;

export function emptyHistory(): QueryHistory {
  return { entries: [], at: -1 };
}

/**
 * Record a query that was just run.
 *
 * Re-running the entry already current is not a new point in history, so it is ignored --
 * otherwise pressing Run twice would make Back a no-op.
 */
export function remember(history: QueryHistory, query: string): QueryHistory {
  if (history.entries[history.at] === query)
    return history;
  const entries = [...history.entries.slice(0, history.at + 1), query];
  return { entries, at: entries.length - 1 };
}

export function canGoBack(history: QueryHistory): boolean {
  return history.at > 0;
}

export function canGoForward(history: QueryHistory): boolean {
  return history.at >= 0 && history.at < history.entries.length - 1;
}

/** Move by one step, or return the history unchanged at either end. */
export function step(history: QueryHistory, delta: number): QueryHistory {
  const at = history.at + delta;
  if (at < 0 || at >= history.entries.length)
    return history;
  return { entries: history.entries, at };
}

export function jumpTo(history: QueryHistory, at: number): QueryHistory {
  if (at < 0 || at >= history.entries.length)
    return history;
  return { entries: history.entries, at };
}

/** An entry offered in a history menu, with the index to jump to. */
export interface HistoryEntry {
  at: number;
  query: string;
}

/**
 * The entries behind the current one, nearest first: what the Back menu offers.
 */
export function backEntries(history: QueryHistory, limit = MENU_LIMIT): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (let at = history.at - 1; at >= 0 && entries.length < limit; at--)
    entries.push({ at, query: history.entries[at] });
  return entries;
}

/** The entries ahead of the current one, nearest first: what the Forward menu offers. */
export function forwardEntries(history: QueryHistory, limit = MENU_LIMIT): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (let at = history.at + 1; at < history.entries.length && entries.length < limit; at++)
    entries.push({ at, query: history.entries[at] });
  return entries;
}

/** A query on one line, for a menu row. */
export function summarize(query: string, maxLength = 80): string {
  const oneLine = query.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}
