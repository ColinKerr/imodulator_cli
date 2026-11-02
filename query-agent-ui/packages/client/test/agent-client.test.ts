import { describe, expect, it } from "vitest";
import { AgentClient, type AgentStatus } from "../src/agent-client";
import { earlierQuestion, type StartupList } from "../src/client";
import { HISTORY_CAPS } from "../src/turn-api";
import { fakeQueries, response, scriptedTurns } from "./helpers";

const list: StartupList = { lists: {}, queries: [{ rule: "r", id: "count", ecsql: "SELECT COUNT(*) FROM e" }] };

describe("AgentClient", () => {
  it("runs the startup list when it starts, once, and sends its rows with every turn", async () => {
    const runQuery = fakeQueries({ "SELECT COUNT(*) FROM e": [[7]], "SELECT 1": [[1]] }, 50);
    const exploring: boolean[] = [];
    const turns = scriptedTurns(response(["SELECT 1"]), response([], { answer: "a" }), response([], { answer: "b" }));
    const client = AgentClient.start({ runQuery, imodelName: "file.bim", turns, startupList: list, onExploring: (on) => exploring.push(on) });
    expect(runQuery.asked).toEqual(["SELECT COUNT(*) FROM e"]);

    const statuses: AgentStatus[] = [];
    await client.ask("first", { onStatus: (status) => statuses.push(status) });
    const later: AgentStatus[] = [];
    await client.ask("second", { onStatus: (status) => later.push(status) });
    expect(later).toEqual([{ phase: "thinking" }]);
    expect(runQuery.asked.filter((q) => q.includes("COUNT"))).toHaveLength(1);
    expect(exploring).toEqual([true, false]);
    expect(turns.requests.map((r) => r.imodel?.startup?.[0].rows)).toEqual([[[7]], [[7]], [[7]]]);
    expect(statuses).toEqual([{ phase: "exploring" }, { phase: "thinking" }, { phase: "querying", ecsql: "SELECT 1" }, { phase: "thinking" }]);
  });

  it("asks with no iModel: no startup list, and no queries offered", async () => {
    const turns = scriptedTurns(response([], { answer: "ECSql is SQL for EC." }));
    const run = await AgentClient.start({ turns }).ask("What is ECSql?");
    expect(run.answer).toBe("ECSql is SQL for EC.");
    expect(turns.requests[0]).toMatchObject({ canQuery: false });
    expect(turns.requests[0].imodel).toBeUndefined();
  });

  it("needs a function URL or a way to send turns", () => {
    expect(() => AgentClient.start({})).toThrow(/functionUrl/);
  });
});

describe("earlierQuestion", () => {
  it("keeps the answer's rows only up to HISTORY_CAPS, and a cut cell's full length", async () => {
    const long = "x".repeat(300);
    const run = {
      answer: "A.", query: "SELECT v FROM t", stoppedBecause: "answered" as const, runId: "r", token: "t",
      answerRows: { columns: ["v"], rows: [[`${long.slice(0, 250)}`], ...Array.from({ length: 30 }, (_, i) => [i])], clipped: [[0, 0, 900]] as [number, number, number][] },
    };
    const earlier = await earlierQuestion("q", run);
    expect(earlier.rows?.rows?.length).toBeLessThanOrEqual(HISTORY_CAPS.maxRows);
    expect(earlier.rows?.truncatedBy).toBeDefined();
    expect(earlier.rows?.clipped).toEqual([[0, 0, 900]]);
    expect(String(earlier.rows?.rows?.[0][0]).length).toBe(HISTORY_CAPS.maxCellChars);
    expect(await earlierQuestion("q", { ...run, answerRows: { error: "bad" } })).toMatchObject({ rows: { error: "bad" } });
  });
});
