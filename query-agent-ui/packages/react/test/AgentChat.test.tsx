// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { AgentClient, TurnRefused } from "@query-agent/client";
import { AgentChat } from "../src/AgentChat";
import { FAILED } from "../src/chat";
import { button, click, mount, response, rows, scriptedTurns, settle, type } from "./helpers";

function ask(container: HTMLElement, question: string): void {
  type(container.querySelector("textarea")!, question);
  click(button(container, "Ask"));
}

describe("AgentChat", () => {
  it("says why there is no client, and keeps the ask box closed", () => {
    const { container } = mount(<AgentChat unavailable="Enter your access key to ask the agent." />);
    expect(container.querySelector(".qa-notice")?.textContent).toBe("Enter your access key to ask the agent.");
    expect(container.querySelector("textarea")?.disabled).toBe(true);
  });

  it("shows the phase with moving dots while it works, then the answer and its query", async () => {
    let release: () => void = () => {};
    const gate = () => new Promise<void>((resolve) => { release = resolve; });
    const turns = scriptedTurns([response(["SELECT COUNT(*) FROM e"]), response([], { answer: "There are 3.", query: "SELECT COUNT(*) FROM e", outcome: "answered" })], gate);
    const client = AgentClient.start({ turns, runQuery: async () => rows([[3]]), imodelName: "f.bim", startupList: { lists: {}, queries: [] } });
    const onAnswer = vi.fn();
    const onUseQuery = vi.fn();
    const { container } = mount(<AgentChat client={client} onAnswer={onAnswer} onUseQuery={onUseQuery} />);

    ask(container, "How many?");
    await settle();
    expect(container.querySelector(".qa-progress")?.textContent).toMatch(/^Thinking\.{1,3}$/);
    await settle(450);
    expect(container.querySelector(".qa-dots")?.textContent).toMatch(/^\.{1,3}$/);
    release();
    await settle();
    release();
    await settle();

    expect(container.querySelector(".qa-answer-text")?.textContent).toBe("There are 3.");
    expect(container.querySelector(".qa-query code")?.textContent).toBe("SELECT COUNT(*) FROM e");
    expect(onAnswer).toHaveBeenCalledWith({ question: "How many?", answer: "There are 3.", query: "SELECT COUNT(*) FROM e", outcome: "answered" });
    click(button(container, "Use this query"));
    expect(onUseQuery).toHaveBeenCalledWith("SELECT COUNT(*) FROM e");
  });

  it("sends a follow-up the earlier question as the user saw it, and the last run's token, and nothing else of it", async () => {
    const first = response(["SELECT COUNT(*) FROM s.Pipe"]);
    const answered = response([], { answer: "There are 3.", query: "SELECT COUNT(*) FROM s.Pipe" });
    const turns = scriptedTurns([first, answered, response([], { answer: "Second." })]);
    const client = AgentClient.start({ turns, runQuery: async () => rows([[3]]), startupList: { lists: {}, queries: [] } });
    const { container } = mount(<AgentChat client={client} />);
    ask(container, "How many pipes?");
    await settle(10);
    ask(container, "And valves?");
    await settle(10);

    // Within a run, each turn sends the token the last response gave.
    expect(turns.requests[0].token).toBeUndefined();
    expect(turns.requests[1].token).toBe(first.token);
    const followUp = turns.requests[2];
    expect(followUp.question).toBe("And valves?");
    expect(followUp.token).toBe(answered.token);
    expect(followUp.earlier).toEqual([{
      question: "How many pipes?", answer: "There are 3.", query: "SELECT COUNT(*) FROM s.Pipe",
      rows: { columns: ["n"], rows: [[3]] }, stoppedBecause: "answered",
    }]);
    expect(Object.keys(followUp).sort()).toEqual(["canQuery", "earlier", "question", "token"]);
    expect([...container.querySelectorAll(".qa-answer-text")].map((e) => e.textContent)).toEqual(["There are 3.", "Second."]);
    expect(container.textContent).not.toContain("sealed-");
  });

  it("shows the function's sentence when it refuses a question, and tells the host", async () => {
    const refusal = new TurnRefused(429, "That access key has used up its limit, so the agent stopped answering.");
    const client = AgentClient.start({ turns: async () => { throw refusal; } });
    const onRefused = vi.fn();
    const { container } = mount(<AgentChat client={client} onRefused={onRefused} />);
    ask(container, "q");
    await settle(10);
    expect(container.textContent).toContain("That access key has used up its limit, so the agent stopped answering.");
    expect(container.textContent).not.toContain(FAILED);
    expect(onRefused).toHaveBeenCalledWith(refusal);
  });

  it("stops a run when asked, and shows what the agent had", async () => {
    let release: () => void = () => {};
    const gate = () => new Promise<void>((resolve) => { release = resolve; });
    const turns = scriptedTurns([response(["SELECT 1"])], gate);
    const { container } = mount(<AgentChat client={AgentClient.start({ turns, runQuery: async () => rows([[1]]), startupList: { lists: {}, queries: [] } })} />);
    ask(container, "q");
    await settle();
    click(button(container, "Stop"));
    release();
    await settle();
    release();
    await settle();
    expect(turns.requests[turns.requests.length - 1].aborted).toBe(true);
    expect(container.querySelector(".qa-answer-text")?.textContent).toBe("Stopped.");
  });

  it("says a failed run could not finish, without the reason", async () => {
    const client = AgentClient.start({ turns: async () => { throw new Error("HTTP 502 secret-host"); } });
    const { container } = mount(<AgentChat client={client} />);
    ask(container, "q");
    await settle();
    expect(container.querySelector(".qa-error")?.textContent).toBe(FAILED);
    expect(container.textContent).not.toContain("secret");
  });

  it("says the agent is not set up when there is no client, and cannot be asked", () => {
    const { container } = mount(<AgentChat />);
    expect(container.querySelector(".qa-notice")?.textContent).toBe("The agent is not set up.");
    expect(container.querySelector("textarea")?.disabled).toBe(true);
  });
});

describe("AgentChat, driven by the host", () => {
  it("asks a question the host gives, once for each key, and draws the host's buttons under the answer", async () => {
    const turns = scriptedTurns([response([], { answer: "From the host." })]);
    const client = AgentClient.start({ turns });
    const { container, root } = mount(<AgentChat client={client} question={{ text: "the host's question", key: 1 }} answerActions={() => <button type="button">Save</button>} />);
    await settle();
    expect(turns.requests[0].question).toBe("the host's question");
    expect(container.querySelector(".qa-answer-text")?.textContent).toBe("From the host.");
    expect(button(container, "Save")).toBeDefined();
    act(() => root.render(<AgentChat client={client} question={{ text: "the host's question", key: 1 }} />));
    await settle();
    expect(turns.requests).toHaveLength(1);
  });
});
