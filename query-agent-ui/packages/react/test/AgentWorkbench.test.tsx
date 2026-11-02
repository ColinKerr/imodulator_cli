// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { AgentClient } from "@query-agent/client";
import { AgentWorkbench } from "../src/AgentWorkbench";
import { button, click, mount, response, rows, scriptedTurns, settle, type } from "./helpers";

describe("AgentWorkbench", () => {
  it("shows the answer's results and earlier chats, and nothing of how the agent worked", async () => {
    const answered = response([], { answer: "There are 3.", query: "SELECT COUNT(*) FROM e" });
    const turns = scriptedTurns([answered]);
    let reads = 0;
    const client = AgentClient.start({ turns, runQuery: async () => { reads++; return rows([[3]]); }, startupList: { lists: {}, queries: [] } });
    const { container } = mount(<AgentWorkbench client={client} />);

    type(container.querySelector("textarea")!, "How many?");
    click(button(container, "Ask"));
    await settle(10);
    expect(button(container, "Steps")).toBeUndefined();
    expect(button(container, "Notes")).toBeUndefined();
    expect(container.textContent).not.toContain(answered.token);
    expect(container.querySelector(".qa-steps")).toBeNull();

    // The results were read once, when the run ended.
    expect([...container.querySelectorAll(".qa-results td")].map((td) => td.textContent)).toEqual(["3"]);
    expect(reads).toBe(1);

    click(button(container, "New chat"));
    click(button(container, "History"));
    expect(container.querySelector(".qa-history button")?.textContent).toBe("How many?");
    click(container.querySelector(".qa-history button"));
    expect(container.querySelector(".qa-answer-text")?.textContent).toBe("There are 3.");
  });
});
