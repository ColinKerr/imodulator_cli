// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { AgentClient, type AgentRun, type RawQueryResult } from "@query-agent/client";
import { AgentChat } from "../src/AgentChat";
import { AgentWorkbench } from "../src/AgentWorkbench";
import { SELECTION_CHUNK } from "@query-agent/client";
import { replaceWith, SELECTION_LEVEL, SELECTION_SOURCE, selectableOf, selectAnswerElements, selectsNothing, type SelectionTarget } from "../src/selection";
import { button, click, mount, response, scriptedTurns, settle, type } from "./helpers";

const COUNT = "SELECT COUNT(*) FROM bis.Door";
const SELECT = "SELECT ECInstanceId, ec_classname(ECClassId, 's.c') AS ClassName FROM bis.Door";
const LIST = "SELECT ECInstanceId, UserLabel FROM bis.Door";
const KEYED = "SELECT ECInstanceId, ec_classname(ECClassId, 's.c') AS ClassName, UserLabel FROM bis.Door";

function table(columns: string[], data: unknown[][]): RawQueryResult {
  return { columns, rows: (async function* () { yield* data; })() };
}

/** The iModel: three doors, 0x1 to 0x3, and the class-filling query the client sends. */
function runQuery(ecsql: string): Promise<RawQueryResult> {
  if (ecsql === COUNT)
    return Promise.resolve(table(["n"], [[3]]));
  if (ecsql === SELECT)
    return Promise.resolve(table(["ECInstanceId", "ClassName"], [["0x1", "Arch.Door"], ["0x2", "Arch.Door"], ["0x3", "Arch.Door"]]));
  if (ecsql === LIST)
    return Promise.resolve(table(["ECInstanceId", "UserLabel"], [["0x1", "D1"], ["0x2", "D2"], ["0x9", "an aspect"]]));
  if (ecsql === KEYED)
    return Promise.resolve(table(["ECInstanceId", "ClassName", "UserLabel"], [["0x1", "Arch.Door", "D1"], ["0x2", "Arch.Door", "D2"], ["0x1", "BisCore.ExternalSourceAspect", "an aspect"]]));
  const check = /ec_classid\('([^']+)'\) AND TargetECInstanceId/.exec(ecsql);
  if (check)
    return Promise.resolve(table(["n"], [[check[1].includes("Aspect") ? 0 : 1]]));
  if (ecsql.startsWith("SELECT COUNT(*) FROM ("))
    return Promise.resolve(table(["n"], [[3]]));
  const fill = /FROM bis\.Element WHERE ECInstanceId IN \(([\d,]+)\)$/.exec(ecsql);
  if (fill)
    return Promise.resolve(table(["ECInstanceId", "c"], fill[1].split(",").filter((id) => Number(id) <= 3).map((id) => [`0x${Number(id).toString(16)}`, "Arch.Door"])));
  return Promise.reject(new Error(`no such query: ${ecsql}`));
}

function store(): SelectionTarget & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { calls, replaceSelection: (props) => calls.push(props), addToSelection: (props) => calls.push({ add: true, ...props }) };
}

/** A run that ends with this answer, and in the selectable mode with this selection query. */
/** A run that ends with this answer, and, in a mode, what the function says the answer is. */
function ended(query: string, resultType?: "selection" | "answer") {
  const end = response([], { answer: "Three doors.", query, outcome: "answered" });
  return resultType ? { ...end, done: { ...end.done!, resultType } } : end;
}

function ask(container: HTMLElement, question: string): void {
  type(container.querySelector("textarea")!, question);
  click(button(container, "Ask"));
}

const NO_STARTUP = { lists: {}, queries: [] };

describe("selecting an answer's elements", () => {
  it("offers the elements of an answer's rows, and replaces the selection as the agent, at level 0", async () => {
    const storage = store();
    const onSelected = vi.fn();
    const client = AgentClient.start({ turns: scriptedTurns([ended(SELECT, "selection")]), runQuery, startupList: NO_STARTUP, answerMode: "auto" });
    const { container } = mount(<AgentChat client={client} selection={{ storage, imodelKey: "key-1", onSelected }} />);
    ask(container, "Select the doors.");
    await settle();
    click(button(container, "Select 3 elements"));
    await settle();
    expect(storage.calls).toEqual([{
      imodelKey: "key-1", source: SELECTION_SOURCE, level: SELECTION_LEVEL,
      selectables: [{ className: "Arch.Door", id: "0x1" }, { className: "Arch.Door", id: "0x2" }, { className: "Arch.Door", id: "0x3" }],
    }]);
    expect(SELECTION_SOURCE).toBe("QueryAgent");
    expect(onSelected).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".qa-answer-actions")?.textContent).toContain("Selected 3 elements.");
  });

  it("with autoSelect, replaces the selection when the answer arrives", async () => {
    const storage = store();
    const client = AgentClient.start({ turns: scriptedTurns([ended(SELECT, "selection")]), runQuery, startupList: NO_STARTUP, answerMode: "auto" });
    const { container } = mount(<AgentWorkbench client={client} selection={{ storage, imodelKey: "key-1", autoSelect: true }} />);
    ask(container, "Select the doors.");
    await settle();
    expect(storage.calls).toHaveLength(1);
  });

  it("without the mode, selects every element of rows that carry ECInstanceId and ClassName, read again in full, leaving out non-elements", async () => {
    const storage = store();
    const asked: string[] = [];
    const client = AgentClient.start({ turns: scriptedTurns([ended(KEYED)]), runQuery: (ecsql) => { asked.push(ecsql); return runQuery(ecsql); }, startupList: NO_STARTUP });
    const { container } = mount(<AgentChat client={client} selection={{ storage, imodelKey: "key-1", autoSelect: true }} answerActions={() => <span>host</span>} />);
    ask(container, "Which doors?");
    await settle();
    // Selected automatically, after the answer was shown: the aspect that shares 0x1 is left out.
    expect(storage.calls).toEqual([{ imodelKey: "key-1", source: "QueryAgent", level: 0, selectables: [{ className: "Arch.Door", id: "0x1" }, { className: "Arch.Door", id: "0x2" }] }]);
    expect(asked.filter((q) => q === KEYED).length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".qa-answer-actions")?.textContent).toContain("host");
  });

  it("offers nothing for rows with an id but no ClassName", async () => {
    const storage = store();
    const client = AgentClient.start({ turns: scriptedTurns([ended(LIST)]), runQuery, startupList: NO_STARTUP });
    const { container } = mount(<AgentChat client={client} selection={{ storage, imodelKey: "key-1", autoSelect: true }} />);
    ask(container, "Which doors?");
    await settle();
    expect(storage.calls).toHaveLength(0);
    expect(container.querySelector(".qa-answer-actions button")).toBeNull();
  });

  it("lets a later answer's selection stand when an earlier, longer read finishes after it", async () => {
    const storage = store();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const SLOW = "SELECT ECInstanceId, ec_classname(ECClassId, 's.c') AS ClassName FROM bis.ElementAspect";
    const slowQuery = (ecsql: string): Promise<RawQueryResult> => ecsql === SLOW
      ? Promise.resolve(table(["ECInstanceId", "ClassName"], [])).then(async (result) => { await slow; return result; })
      : runQuery(ecsql);
    const client = AgentClient.start({ turns: scriptedTurns([]), runQuery: slowQuery, startupList: NO_STARTUP });
    const run = (query: string): AgentRun => ({ answer: "a", stoppedBecause: "answered", runId: "r", token: "t", query, answerRows: { columns: ["ECInstanceId", "ClassName"], rows: [["0x1", "Arch.Door"]] } });
    const earlier = selectAnswerElements(run(SLOW), client, storage, "k");
    const later = await selectAnswerElements(run(SELECT), client, storage, "k");
    release();
    expect(await earlier).toBeUndefined();
    expect(later?.selected).toHaveLength(3);
    // Only the later answer changed the selection: the earlier one's empty result did not clear it.
    expect(storage.calls).toHaveLength(1);
    expect(storage.calls[0]).toMatchObject({ selectables: { length: 3 } });
  });

  it("clears the selection when a selection request finds nothing", async () => {
    const storage = store();
    const empty = { columns: ["ECInstanceId", "ClassName"], rows: [] as unknown[][] };
    const base: AgentRun = { answer: "None.", stoppedBecause: "answered", runId: "r", token: "t", query: SELECT, resultType: "selection", answerRows: empty };
    const client = AgentClient.start({ turns: scriptedTurns([]), runQuery, startupList: NO_STARTUP });
    expect(selectsNothing(base)).toBe(true);
    expect(await selectAnswerElements(base, client, storage, "k")).toEqual({ selected: [], count: 0, notElements: 0 });
    expect(storage.calls).toEqual([{ imodelKey: "k", source: "QueryAgent", level: 0, selectables: [] }]);
    // not_found with no query clears it too; the same empty rows in a normal answer change nothing.
    expect(selectsNothing({ ...base, query: undefined, answerRows: undefined, structured: { explanation: "None.", query: "", outcome: "not_found", rowLimitIntended: false } })).toBe(true);
    expect(selectsNothing({ ...base, resultType: "answer" })).toBe(false);
    expect(selectsNothing({ ...base, answerRows: { columns: ["n"], rows: [] } })).toBe(false);
  });

  it("puts a large selection in the store in chunks: the first replaces it, the rest are added", () => {
    const storage = store();
    const keys = Array.from({ length: SELECTION_CHUNK + 5 }, (_, i) => ({ className: "Arch.Door", id: `0x${(i + 1).toString(16)}` }));
    replaceWith(storage, "k", keys);
    expect(storage.calls).toHaveLength(2);
    expect(storage.calls[0]).toMatchObject({ selectables: { length: SELECTION_CHUNK } });
    expect(storage.calls[1]).toMatchObject({ add: true, selectables: { length: 5 } });
  });

  it("offers nothing for an answer without elements, and says why its elements could not be read", async () => {
    const run: AgentRun = { answer: "a", stoppedBecause: "answered", runId: "r", token: "t", answerRows: { columns: ["n"], rows: [[3]] } };
    expect(selectableOf(run)).toBeUndefined();
    expect(selectableOf({ ...run, answerRows: { columns: ["ECInstanceId", "ClassName"], rows: [] } })).toBeUndefined();
    const client = AgentClient.start({ turns: scriptedTurns([ended(COUNT, "answer")]), runQuery, startupList: NO_STARTUP, answerMode: "auto" });
    const { container } = mount(<AgentChat client={client} selection={{ storage: store(), imodelKey: "k" }} />);
    ask(container, "How many doors?");
    await settle();
    expect(container.querySelector(".qa-answer-actions button")).toBeNull();
    const broken: AgentRun = { ...run, query: "SELECT broken", answerRows: { columns: ["ECInstanceId", "ClassName"], rows: [["0x1", "Arch.Door"]] } };
    await expect(selectAnswerElements(broken, client, store(), "k")).rejects.toThrow("no such query: SELECT broken");
  });
});
