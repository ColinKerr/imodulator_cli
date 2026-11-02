import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { driveTurns, fetchTurns, runStartupQueries, TurnRefused, type StartupList } from "../src/client";
import type { TurnRequest } from "../src/turn-api";
import { CAPS, fakeQueries, response, scriptedTurns } from "./helpers";

let server: http.Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("driveTurns", () => {
  it("runs the queries a response asks for, sends their rows with the next turn, and reports each phase", async () => {
    const turns = scriptedTurns(response(["SELECT 1"]), response([], { answer: "one", query: "SELECT 1" }));
    const phases: string[] = [];
    const run = await driveTurns("q", { runQuery: fakeQueries({ "SELECT 1": [[1]] }), onPhase: (phase) => phases.push(phase) }, turns);
    expect(run).toMatchObject({ answer: "one", query: "SELECT 1", stoppedBecause: "answered" });
    expect(turns.requests[0]).toMatchObject({ question: "q", canQuery: true });
    expect(turns.requests[1].results).toEqual([expect.objectContaining({ ecsql: "SELECT 1", columns: ["n"], rows: [[1]] })]);
    expect(phases).toEqual(["thinking", "querying", "thinking"]);
  });

  it("sends a query's error, for the model to correct", async () => {
    const turns = scriptedTurns(response(["SELECT bad"]), response([], { answer: "done" }));
    await driveTurns("q", { runQuery: fakeQueries({}) }, turns);
    expect(turns.requests[1].results?.[0]).toMatchObject({ ecsql: "SELECT bad", error: "no such query: SELECT bad" });
  });
});

describe("a refusal in the middle of a run", () => {
  it("ends the question with the function's sentence, once its queries have run", async () => {
    const phases: string[] = [];
    let turn = 0;
    const turns = async () => {
      if (turn++ === 0)
        return response(["SELECT 1"]);
      throw new TurnRefused(429, "That access key has used up its limit, so the agent stopped answering.");
    };
    await expect(driveTurns("q", { runQuery: fakeQueries({ "SELECT 1": [[1]] }), onPhase: (phase) => phases.push(phase) }, turns))
      .rejects.toMatchObject({ status: 429, message: expect.stringContaining("used up its limit") });
    expect(phases).toEqual(["thinking", "querying", "thinking"]);
  });
});

describe("fetchTurns", () => {
  async function serve(handler: (request: TurnRequest, headers: http.IncomingHttpHeaders) => [number, unknown]): Promise<string> {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const [status, reply] = handler(JSON.parse(body) as TurnRequest, req.headers);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  }

  it("posts the turn to <url>/turn, with the access token when there is one", async () => {
    let auth: string | undefined;
    const url = await serve((_request, headers) => {
      auth = headers.authorization;
      return [200, response([], { answer: "a" })];
    });
    const turn = fetchTurns(`${url}/`, { getAccessToken: async () => "t0k" });
    const reply = await turn({ question: "q", canQuery: false });
    expect(reply.done?.answer).toBe("a");
    expect(auth).toBe("Bearer t0k");
  });

  it("says when the function refuses a turn", async () => {
    const url = await serve(() => [502, { error: "The turn failed. The function's log has the reason." }]);
    await expect(fetchTurns(url)({ question: "q", canQuery: false }))
      .rejects.toThrow(/HTTP 502.*function's log/);
  });

  it("gives a refusal the user can act on as TurnRefused, with the function's sentence", async () => {
    for (const status of [400, 401, 403, 413, 429]) {
      const url = await serve(() => [status, { error: `sentence ${status}` }]);
      const refused = await fetchTurns(url)({ question: "q", canQuery: false }).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(TurnRefused);
      expect(refused).toMatchObject({ status, message: `sentence ${status}` });
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    const url = await serve(() => [502, { error: "The turn failed." }]);
    expect(await fetchTurns(url)({ question: "q", canQuery: false }).catch((err: unknown) => err)).not.toBeInstanceOf(TurnRefused);
  });
});

describe("runStartupQueries", () => {
  const list: StartupList = {
    lists: { words: ["seat", "chair"] },
    queries: [
      { rule: "r", id: "things", ecsql: "SELECT name FROM t WHERE {{like:name:words}}", max: 2, each: "SELECT COUNT(*) FROM [{0}]" },
      { rule: "r", id: "fallback", ecsql: "SELECT 1", onlyIfEmpty: ["things"] },
    ],
  };

  it("runs every count to the end, with no time limit, and skips a fallback when the first query found rows", async () => {
    const runQuery = fakeQueries({
      "SELECT name FROM t WHERE (name LIKE '%seat%' OR name LIKE '%chair%')": [["A"], ["B"], ["C"]],
      "SELECT COUNT(*) FROM [A]": [[4]],
      "SELECT COUNT(*) FROM [B]": [[5]],
    }, 1100);
    const { results } = await runStartupQueries(list, runQuery);
    expect(results[0]).toMatchObject({ rows: [["A"], ["B"]], count: 3, each: ["4", "5"] });
    expect(results[1]).toMatchObject({ skipped: true });
    expect(CAPS.maxRows).toBe(200);
  }, 10_000);
});
