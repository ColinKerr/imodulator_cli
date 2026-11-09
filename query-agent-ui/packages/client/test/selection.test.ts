import { describe, expect, it } from "vitest";
import { AgentClient } from "../src/agent-client";
import type { RunRawQuery } from "../src/caps";
import { CLASS_BATCH, hasKeyColumns, instanceKeys, readSelection, SELECTION_CHUNK, SELECTION_SAMPLE, toId } from "../src/selection";
import { response, rows, scriptedTurns } from "./helpers";

const SELECT = "SELECT ECInstanceId, ec_classname(ECClassId, 's.c') AS ClassName FROM bis.Door";

/**
 * A query function for selections: answers `table` by ECSql, and the class-filling query from
 * `classes`, an element's class by its decimal id. Records what it was asked.
 */
function selectionQueries(table: Record<string, { columns: string[]; rows: unknown[][] }>, classes: Record<string, string> = {}): RunRawQuery & { asked: string[] } {
  const asked: string[] = [];
  const run = (async (ecsql: string) => {
    asked.push(ecsql);
    // The element-class check: every class is an element class except aspects.
    const check = /ec_classid\('([^']+)'\) AND TargetECInstanceId/.exec(ecsql);
    if (check)
      return rows(["n"], [[check[1].includes("Aspect") ? 0 : 1]]);
    const fill = /^SELECT ECInstanceId, ec_classname\(ECClassId, 's\.c'\) FROM bis\.Element WHERE ECInstanceId IN \(([\d,]+)\)$/.exec(ecsql);
    if (fill) {
      const ids = fill[1].split(",");
      return rows(["ECInstanceId", "c"], ids.filter((id) => classes[id]).map((id) => [`0x${BigInt(id).toString(16)}`, classes[id]]));
    }
    const found = table[ecsql];
    if (!found)
      throw new Error(`no such query: ${ecsql}`);
    return rows(found.columns, found.rows);
  }) as RunRawQuery & { asked: string[] };
  run.asked = asked;
  return run;
}

describe("readSelection", () => {
  it("reads every row, with no cap, as instance keys, each element once", async () => {
    const many = Array.from({ length: 5_000 }, (_, i) => [`0x${(i + 1).toString(16)}`, "Arch.Door"]);
    const runQuery = selectionQueries({ [SELECT]: { columns: ["ECInstanceId", "ClassName"], rows: [...many, ["0x1", "Arch.Door"]] } });
    const selection = await readSelection(runQuery, SELECT);
    expect(selection).toMatchObject({ notElements: 0 });
    expect("keys" in selection && selection.keys.length).toBe(5_000);
    expect("keys" in selection && selection.keys[0]).toEqual({ className: "Arch.Door", id: "0x1" });
    // The query gave every class, so only that class was checked, once.
    expect(runQuery.asked).toHaveLength(2);
    expect(runQuery.asked[1]).toContain("ec_classid('Arch.Door')");
  });

  it("normalises ids to hex and class names to Schema.Class", async () => {
    const runQuery = selectionQueries({ [SELECT]: { columns: ["ecinstanceid", "classname"], rows: [["26", "Arch:Door"], [27, "Arch.Door"], ["0X1C", "Arch.Door"]] } });
    expect(await readSelection(runQuery, SELECT)).toEqual({
      keys: [{ className: "Arch.Door", id: "0x1a" }, { className: "Arch.Door", id: "0x1b" }, { className: "Arch.Door", id: "0x1c" }], count: 3, notElements: 0,
    });
  });

  it("fills in a missing class from bis.Element in batches, and counts the ids that are not elements", async () => {
    const ids = "SELECT a.Element.Id AS ECInstanceId FROM bis.ElementAspect a";
    const total = CLASS_BATCH + 5;
    const classes = Object.fromEntries(Array.from({ length: total }, (_, i) => [String(i + 1), "Arch.Wall"]).filter(([id]) => id !== "7"));
    const runQuery = selectionQueries({ [ids]: { columns: ["ECInstanceId"], rows: [...Array.from({ length: total }, (_, i) => [`0x${(i + 1).toString(16)}`]), [null]] } }, classes);
    const selection = await readSelection(runQuery, ids);
    expect(runQuery.asked).toHaveLength(3);
    expect(/IN \(([\d,]+)\)/.exec(runQuery.asked[1])![1].split(",")).toHaveLength(CLASS_BATCH);
    expect(selection).toMatchObject({ notElements: 2 });
    expect("keys" in selection && selection.keys.length).toBe(total - 1);
    expect("keys" in selection && selection.keys.some((key) => key.id === "0x7")).toBe(false);
  });

  it("fills in only the rows whose class is null", async () => {
    const runQuery = selectionQueries({ [SELECT]: { columns: ["ECInstanceId", "ClassName"], rows: [["0x1", "Arch.Door"], ["0x2", null]] } }, { 2: "Arch.Window" });
    expect(await readSelection(runQuery, SELECT)).toEqual({ keys: [{ className: "Arch.Door", id: "0x1" }, { className: "Arch.Window", id: "0x2" }], count: 2, notElements: 0 });
    expect(runQuery.asked.at(-1)).toMatch(/IN \(2\)$/);
  });

  it("keeps a key only when its class is an element class: an aspect with an element's id is not that element", async () => {
    const runQuery = selectionQueries({ [SELECT]: { columns: ["ECInstanceId", "ClassName"], rows: [
      ["0x20000000001", "BisCore.ExternalSourceAspect"], ["0x20000000001", "BisCore.SynchronizationConfigLink"], ["0x5", "Bad'Name.X"],
    ] } });
    expect(await readSelection(runQuery, SELECT)).toEqual({ keys: [{ className: "BisCore.SynchronizationConfigLink", id: "0x20000000001" }], count: 1, notElements: 2 });
    // A class name that is not Schema.Class is never written into a query.
    expect(runQuery.asked.some((q) => q.includes("Bad'Name"))).toBe(false);
  });

  it("hands the keys on in chunks as they are read", async () => {
    const many = Array.from({ length: SELECTION_CHUNK * 2 + 3 }, (_, i) => [`0x${(i + 1).toString(16)}`, "Arch.Door"]);
    const runQuery = selectionQueries({ [SELECT]: { columns: ["ECInstanceId", "ClassName"], rows: many } });
    const chunks: number[] = [];
    const selection = await readSelection(runQuery, SELECT, (keys) => { chunks.push(keys.length); });
    expect(chunks).toEqual([SELECTION_CHUNK, SELECTION_CHUNK, 3]);
    // The chunks are the host's to hold: only a sample is kept, and the count is the full one.
    expect(selection).toMatchObject({ count: many.length });
    expect("keys" in selection && selection.keys.length).toBe(SELECTION_SAMPLE);
  });

  it("calls a result selectable only with both ECInstanceId and ClassName", () => {
    expect(hasKeyColumns(["ECInstanceId", "ClassName", "UserLabel"])).toBe(true);
    expect(hasKeyColumns(["ecinstanceid", "classname"])).toBe(true);
    expect(hasKeyColumns(["ECInstanceId", "UserLabel"])).toBe(false);
    expect(hasKeyColumns(["id", "ClassName"])).toBe(false);
    expect(hasKeyColumns(undefined)).toBe(false);
  });

  it("says why when there is no id column, or the query fails", async () => {
    const labels = "SELECT UserLabel FROM bis.Door";
    const runQuery = selectionQueries({ [labels]: { columns: ["UserLabel"], rows: [["D1"]] } });
    expect(await readSelection(runQuery, labels)).toEqual({ error: 'The selection query returned no ECInstanceId column, only ["UserLabel"].' });
    expect(await readSelection(runQuery, "SELECT nonsense")).toEqual({ error: "no such query: SELECT nonsense" });
  });
});

describe("instanceKeys", () => {
  it("gives each element once, with its class, and counts the ids that are not elements", async () => {
    const runQuery = selectionQueries({}, { 1: "Arch.Door" });
    expect(await instanceKeys(runQuery, ["0x1", "1", "0x2", "junk"])).toEqual({ keys: [{ className: "Arch.Door", id: "0x1" }], notElements: 3 });
  });

  it("reads ids as hex", () => {
    expect([toId("0x1A"), toId("26"), toId(26), toId("0"), toId("x"), toId(null)]).toEqual(["0x1a", "0x1a", "0x1a", undefined, undefined, undefined]);
  });
});

describe("AgentClient with an answer mode", () => {
  const done = (resultType?: "selection" | "answer") => {
    const end = response([], { answer: "There are 2 doors.", query: "SELECT COUNT(*) FROM bis.Door" });
    return resultType ? { ...end, done: { ...end.done!, resultType } } : end;
  };

  it("sends the host's mode with every turn, as it is, and keeps what the function says the answer is", async () => {
    const turns = scriptedTurns(response(["SELECT COUNT(*) FROM bis.Door"]), done("selection"));
    const client = AgentClient.start({ runQuery: selectionQueries({ "SELECT COUNT(*) FROM bis.Door": { columns: ["n"], rows: [[2]] } }), turns, startupList: { lists: {}, queries: [] }, answerMode: "auto" });
    const run = await client.ask("Select them.");
    // The client never scans the question: a request to select is still sent as the host's mode.
    expect(turns.requests.map((request) => request.answerMode)).toEqual(["auto", "auto"]);
    expect(run.answerMode).toBe("auto");
    expect(run.resultType).toBe("selection");
    expect(run).not.toHaveProperty("selection");
  });

  it("takes the mode per question, and sends none by default", async () => {
    const turns = scriptedTurns(done(), done("selection"));
    const client = AgentClient.start({ runQuery: selectionQueries({}), turns, startupList: { lists: {}, queries: [] } });
    const plain = await client.ask("How many doors?");
    await client.ask("Which doors?", { answerMode: "select" });
    expect(turns.requests[0]).not.toHaveProperty("answerMode");
    expect(turns.requests[1].answerMode).toBe("select");
    expect(plain.resultType).toBeUndefined();
  });

  it("gives instance keys for ids", async () => {
    const client = AgentClient.start({ runQuery: selectionQueries({}, { 5: "Arch.Door" }), turns: scriptedTurns(), startupList: { lists: {}, queries: [] } });
    expect(await client.instanceKeys(["0x5", "0x6"])).toEqual({ keys: [{ className: "Arch.Door", id: "0x5" }], notElements: 1 });
  });
});
