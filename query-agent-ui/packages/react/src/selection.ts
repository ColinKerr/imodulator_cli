/**
 * Selecting the elements an answer is about, in the host's unified selection store.
 *
 * - **An answer whose rows carry `ECInstanceId` and `ClassName` is about those elements:** its
 *   query is read again in full to select them, so the number selected is never limited (the
 *   owner's decisions D1 and D2).
 * - **An answer whose `resultType` is `selection`** (the user asked to select) that found nothing
 *   clears the selection.
 * - **Large selections go to the store in chunks** (`SELECTION_CHUNK`): the first replaces the
 *   selection and the rest are added, as the keys are read.
 *
 * The store is typed by the methods used, so this package does not depend on
 * `@itwin/unified-selection`. A `SelectionStorage` from that package fits.
 */

import { hasKeyColumns, SELECTION_CHUNK, type AgentClient, type AgentRun, type AnswerRows, type InstanceKey } from "@query-agent/client";

/** The part of `SelectionStorage` (`@itwin/unified-selection`) that is used. */
export interface SelectionTarget {
  replaceSelection(props: { imodelKey: string; source: string; selectables: InstanceKey[]; level?: number }): void;
  addToSelection(props: { imodelKey: string; source: string; selectables: InstanceKey[]; level?: number }): void;
}

/** The name the agent's changes to the selection carry. */
export const SELECTION_SOURCE = "QueryAgent";

/** The selection level the agent replaces: the top one, as a click in the viewport does. */
export const SELECTION_LEVEL = 0;

/**
 * Whether an answer's rows can be selected (the owner's decision D1): they have both the
 * `ECInstanceId` and the `ClassName` columns. An id alone is not enough, since ids are not unique
 * across tables.
 */
export function rowsSelectable(rows: AnswerRows | undefined): boolean {
  return rows !== undefined && rows.error === undefined && hasKeyColumns(rows.columns);
}

/**
 * What an answer offers to select. Undefined when it offers nothing: rows without both key
 * columns, or no rows.
 *
 * - `count` is the number of elements when the rows were read in full. Otherwise it is undefined,
 *   and selecting reads them all.
 */
export function selectableOf(run: AgentRun | undefined): { count?: number } | undefined {
  const rows = run?.answerRows;
  if (!rowsSelectable(rows) || (rows!.rows ?? []).length === 0)
    return undefined;
  return { count: rows!.truncatedBy === undefined ? rows!.rows!.length : undefined };
}

/**
 * A selection request that found nothing: an answer whose `resultType` is `selection` and whose
 * query returned no rows (with both key columns), or that ended `not_found`. Selecting it clears
 * the selection, so an earlier answer's elements do not stay selected as if they were the answer.
 */
export function selectsNothing(run: AgentRun | undefined): boolean {
  if (run?.resultType !== "selection" || run.stoppedBecause !== "answered")
    return false;
  const rows = run.answerRows;
  if (run.structured?.outcome === "not_found" && (rows?.rows ?? []).length === 0)
    return true;
  return rowsSelectable(rows) && (rows!.rows ?? []).length === 0 && rows!.truncatedBy === undefined;
}

export interface SelectedElements {
  /**
   * The first `SELECTION_SAMPLE` (1,000) elements selected, with their classes. The keys went to
   * the store in chunks and are not held again here.
   */
  selected: InstanceKey[];
  /** How many elements were selected. */
  count: number;
  /** How many of the rows did not name an element (aspects, models and the like). */
  notElements: number;
}

/**
 * Replace the selection with these elements, as the agent: the first chunk replaces it, and the
 * rest are added in chunks of `SELECTION_CHUNK`, so the hilite and the property grid start on the
 * first chunk rather than waiting for every key.
 */
export function replaceWith(storage: SelectionTarget, imodelKey: string, selectables: InstanceKey[]): void {
  storage.replaceSelection({ imodelKey, source: SELECTION_SOURCE, selectables: selectables.slice(0, SELECTION_CHUNK), level: SELECTION_LEVEL });
  for (let start = SELECTION_CHUNK; start < selectables.length; start += SELECTION_CHUNK)
    storage.addToSelection({ imodelKey, source: SELECTION_SOURCE, selectables: selectables.slice(start, start + SELECTION_CHUNK), level: SELECTION_LEVEL });
}

/** The selection being read in each store, by iModel: a newer one aborts any still being read. */
const reading = new WeakMap<SelectionTarget, Map<string, AbortController>>();

/**
 * Select every element an answer is about, with no limit (the owner's decision D2): all the rows
 * of its query, when they carry `ECInstanceId` and `ClassName`. The query is read again, in full, and the keys go to the store in chunks as they are
 * read. Keys whose class is not an element class are left out. Undefined when the answer offers
 * nothing to select. A selection request that found nothing (`selectsNothing`) clears the
 * selection. Throws the selection's error.
 *
 * A newer call for the same store and iModel supersedes this one: it stops reading, changes the
 * selection no more, and returns undefined. An earlier answer's long read cannot overwrite a later
 * answer's selection.
 */
export async function selectAnswerElements(
  run: AgentRun | undefined, client: AgentClient, storage: SelectionTarget, imodelKey: string,
): Promise<SelectedElements | undefined> {
  const byIModel = reading.get(storage) ?? new Map<string, AbortController>();
  reading.set(storage, byIModel);
  byIModel.get(imodelKey)?.abort();
  const mine = new AbortController();
  byIModel.set(imodelKey, mine);
  const current = () => !mine.signal.aborted;

  if (selectsNothing(run)) {
    storage.replaceSelection({ imodelKey, source: SELECTION_SOURCE, selectables: [], level: SELECTION_LEVEL });
    return { selected: [], count: 0, notElements: 0 };
  }
  const query = run?.structured?.query || run?.query;
  if (!query || !selectableOf(run))
    return undefined;
  let first = true;
  const all = await client.readSelection(query, (keys) => {
    // A newer selection has started: change nothing more (the reader stops on the signal).
    if (!current())
      return;
    if (first)
      storage.replaceSelection({ imodelKey, source: SELECTION_SOURCE, selectables: keys, level: SELECTION_LEVEL });
    else
      storage.addToSelection({ imodelKey, source: SELECTION_SOURCE, selectables: keys, level: SELECTION_LEVEL });
    first = false;
  }, mine.signal);
  if (!current())
    return undefined;
  if ("error" in all)
    throw new Error(all.error);
  // No element at all: the selection is still replaced, so it does not show an earlier answer's.
  if (first)
    storage.replaceSelection({ imodelKey, source: SELECTION_SOURCE, selectables: [], level: SELECTION_LEVEL });
  return { selected: all.keys, count: all.count, notElements: all.notElements };
}

/** The sentence said after a selection. */
export function selectedMessage(result: SelectedElements): string {
  return [
    `Selected ${plural(result.count, "element")}.`,
    result.notElements > 0 ? `${plural(result.notElements, "row")} did not name an element.` : "",
  ].filter(Boolean).join(" ");
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
