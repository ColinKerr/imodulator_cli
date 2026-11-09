/**
 * The elements an answer is about, as instance keys for the host's selection: the selectable mode's
 * `selectionQuery`, run in full on the host's iModel.
 *
 * Nothing here is capped. The number of elements selected is never limited (the owner's decision
 * D6 in the unified selection plan): a cap would select some of the elements and say nothing of
 * the rest. The rows stay with the host. They are never sent to the function.
 */

import type { RunRawQuery } from "./caps";

/** An element as the unified selection names it: its class (`Schema.Class`) and its id (`0x..`). */
export interface InstanceKey {
  className: string;
  id: string;
}

/** The elements a run's `selectionQuery` returned, or why they could not be read. */
export type RunSelection =
  | {
    /**
     * The elements, with their classes: all of them, or, when they were handed on in chunks
     * (`readSelection`'s `onKeys`), only the first `SELECTION_SAMPLE`, so a large selection is not
     * held twice. `count` is always the full number.
     */
    keys: InstanceKey[];
    /** How many elements were selected. */
    count: number;
    /** Rows that named no element: no id, or an id that is not an element's (an aspect, a model). */
    notElements: number;
  }
  | { error: string };

/**
 * How many ids one query asks for the classes of. The runner binds no parameters, so the ids are
 * written into an `IN` list, and a list this long is well inside what SQLite takes.
 */
export const CLASS_BATCH = 1_000;

/** An id as a hex string (`0x1a`), from a hex or decimal string or a number; undefined when it is not one. */
export function toId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number")
    return undefined;
  const text = String(value).trim();
  if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(text))
    return undefined;
  const id = BigInt(text);
  return id > 0n ? `0x${id.toString(16)}` : undefined;
}

/** A class name in the form the selection uses, `Schema.Class`, from that form or `Schema:Class`. */
function className(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().replace(":", ".") : undefined;
}

/** The index of the column with one of these names, in any case; -1 when there is none. */
function columnNamed(columns: readonly string[], ...names: string[]): number {
  for (const name of names) {
    const index = columns.findIndex((column) => column.toLowerCase() === name);
    if (index >= 0)
      return index;
  }
  return -1;
}

/**
 * The classes of the ids that are elements, by id, read in batches of `CLASS_BATCH`. An id that is
 * not an element's is not in the map.
 */
export async function elementClasses(runQuery: RunRawQuery, ids: readonly string[]): Promise<Map<string, string>> {
  const classes = new Map<string, string>();
  for (let start = 0; start < ids.length; start += CLASS_BATCH) {
    // Each id passed `toId`, so it is a number and safe to write into the query.
    const list = ids.slice(start, start + CLASS_BATCH).map((id) => BigInt(id).toString()).join(",");
    const result = await runQuery(`SELECT ECInstanceId, ec_classname(ECClassId, 's.c') FROM bis.Element WHERE ECInstanceId IN (${list})`);
    for await (const row of result.rows) {
      const id = toId(row[0]);
      const name = className(row[1]);
      if (id && name)
        classes.set(id, name);
    }
  }
  return classes;
}

/**
 * The instance keys of ids, for selecting them: each element once, with its class, and how many of
 * the ids were not elements.
 */
export async function instanceKeys(runQuery: RunRawQuery, ids: readonly string[]): Promise<{ keys: InstanceKey[]; notElements: number }> {
  const unique = [...new Set(ids.map(toId).filter((id): id is string => id !== undefined))];
  const classes = await elementClasses(runQuery, unique);
  const keys = unique.flatMap((id) => (classes.has(id) ? [{ className: classes.get(id)!, id }] : []));
  return { keys, notElements: ids.length - keys.length };
}

/** How many keys a selection read in chunks keeps, for a host that wants some of them (to zoom to, say). */
export const SELECTION_SAMPLE = 1_000;

/** How many keys `readSelection` hands on at a time, for a host that adds them to its selection in chunks. */
export const SELECTION_CHUNK = 10_000;

/** A class name that is safe to write into a query: `Schema.Class` with word characters only. */
const CLASS_NAME = /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/;

/**
 * Whether classes are element classes (derived from `BisCore.Element`), each read once. Ids are not
 * unique across tables, so a key is an element's only when its class is an element class: an
 * aspect can have the same id as an unrelated element.
 */
export class ElementClassCheck {
  private readonly known = new Map<string, Promise<boolean>>();
  public constructor(private readonly runQuery: RunRawQuery) { }

  public isElementClass(name: string): Promise<boolean> {
    let found = this.known.get(name);
    if (!found) {
      found = this.read(name);
      this.known.set(name, found);
    }
    return found;
  }

  private async read(name: string): Promise<boolean> {
    if (!CLASS_NAME.test(name))
      return false;
    try {
      const result = await this.runQuery("SELECT COUNT(*) FROM meta.ClassHasAllBaseClasses " +
        `WHERE SourceECInstanceId = ec_classid('${name}') AND TargetECInstanceId = ec_classid('BisCore.Element')`);
      for await (const row of result.rows)
        return Number(row[0]) > 0;
      return false;
    } catch {
      return false;
    }
  }
}

/** The columns of a result that name elements: the id (`ECInstanceId`, or `id`) and the class (`ClassName`, -1 when absent). */
export function keyColumns(columns: readonly string[]): { idAt: number; classAt: number } {
  return { idAt: columnNamed(columns, "ecinstanceid", "id"), classAt: columnNamed(columns, "classname") };
}

/**
 * Whether a result can be selected as it is (the owner's decision D1): it has both the
 * `ECInstanceId` and the `ClassName` columns.
 */
export function hasKeyColumns(columns: readonly string[] | undefined): boolean {
  const { classAt } = keyColumns(columns ?? []);
  return classAt >= 0 && columnNamed(columns ?? [], "ecinstanceid") >= 0;
}

/**
 * Run a selection query in full and read its rows as instance keys. Each element is kept once.
 *
 * - **The query is read with one reader,** which pages through the result itself; nothing is
 *   capped.
 * - **The id is read from the `ECInstanceId` column (or `id`), and the class from `ClassName`.**
 *   A key is kept only when its class is an element class (`ElementClassCheck`). Where the query
 *   gave no class, it is read from `bis.Element`.
 * - **`onKeys` is given the keys in chunks of `SELECTION_CHUNK`** as they are read, for a host
 *   that adds them to its selection as they come.
 * - **`signal`** stops the reading (checked every 1,000 rows): a newer selection supersedes this one.
 *
 * Never throws: a failure is the selection's `error`.
 */
export async function readSelection(runQuery: RunRawQuery, ecsql: string,
  onKeys?: (keys: InstanceKey[]) => void | Promise<void>, signal?: AbortSignal): Promise<RunSelection> {
  try {
    const result = await runQuery(ecsql);
    const { idAt, classAt } = keyColumns(result.columns);
    if (idAt < 0)
      return { error: `The selection query returned no ECInstanceId column, only ${JSON.stringify(result.columns)}.` };
    const check = new ElementClassCheck(runQuery);
    // Each element once: the ids seen, by class (no key strings are built for this).
    const seen = new Map<string, Set<string>>();
    const isNew = (name: string, id: string): boolean => {
      let ids = seen.get(name);
      if (!ids) {
        ids = new Set<string>();
        seen.set(name, ids);
      }
      if (ids.has(id))
        return false;
      ids.add(id);
      return true;
    };
    const unnamed = new Set<string>();
    const keys: InstanceKey[] = [];
    let count = 0;
    let pending: InstanceKey[] = [];
    let notElements = 0;
    const keep = async (key: InstanceKey) => {
      count++;
      // Handed on in chunks, the keys are the host's to hold: only a sample is kept here.
      if (!onKeys || keys.length < SELECTION_SAMPLE)
        keys.push(key);
      if (!onKeys)
        return;
      pending.push(key);
      if (onKeys && pending.length >= SELECTION_CHUNK) {
        const chunk = pending;
        pending = [];
        await onKeys(chunk);
      }
    };
    let read = 0;
    for await (const row of result.rows) {
      if (signal && ++read % 1_000 === 0 && signal.aborted)
        return { error: "The selection was superseded." };
      const id = toId(row[idAt]);
      if (!id) {
        notElements++;
        continue;
      }
      const name = classAt >= 0 ? className(row[classAt]) : undefined;
      if (name === undefined) {
        unnamed.add(id);
        continue;
      }
      if (!isNew(name, id))
        continue;
      if (await check.isElementClass(name))
        await keep({ className: name, id });
      else
        notElements++;
    }
    if (unnamed.size > 0) {
      const classes = await elementClasses(runQuery, [...unnamed]);
      for (const id of unnamed) {
        const name = classes.get(id);
        if (name && isNew(name, id)) {
          await keep({ className: name, id });
        } else if (!name) {
          notElements++;
        }
      }
    }
    if (onKeys && pending.length > 0)
      await onKeys(pending);
    return { keys, count, notElements };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
