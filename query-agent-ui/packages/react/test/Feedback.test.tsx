// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { feedbackOf, FeedbackForm } from "../src/Feedback";
import type { ChatTurn } from "../src/chat";
import { button, click, mount, settle, type } from "./helpers";

const turn: ChatTurn = { question: "How many?", answer: "There are 3.", query: "SELECT COUNT(*) FROM e", outcome: "answered" };

describe("the feedback form", () => {
  it("leaves out corrections that change nothing, and empty text", () => {
    expect(feedbackOf(turn, "right", { correctedAnswer: "There are 3.", correctedQuery: " SELECT COUNT(*) FROM e ", comment: "  " }))
      .toEqual({ question: "How many?", answer: "There are 3.", query: "SELECT COUNT(*) FROM e", rating: "right" });
  });

  it("shows exactly what will be sent, and sends only that when the user chooses", async () => {
    const onFeedback = vi.fn();
    const { container } = mount(<FeedbackForm turn={{ ...turn, run: { systemPrompt: "SECRET PROMPT" } as ChatTurn["run"] }} onFeedback={onFeedback} />);
    click(button(container, "Wrong"));
    const [answer, query, comment] = [...container.querySelectorAll("textarea")];
    type(answer, "There are 4.");
    type(query, "SELECT COUNT(*) FROM e WHERE x");
    type(comment, "It missed one.");
    click(button(container, "Review what will be sent"));
    const preview = JSON.parse(container.querySelector(".qa-feedback-preview")!.textContent!);
    const expected = {
      question: "How many?", answer: "There are 3.", query: "SELECT COUNT(*) FROM e", rating: "wrong",
      correctedAnswer: "There are 4.", correctedQuery: "SELECT COUNT(*) FROM e WHERE x", comment: "It missed one.",
    };
    expect(preview).toEqual(expected);
    expect(container.textContent).not.toContain("SECRET");
    expect(onFeedback).not.toHaveBeenCalled();
    click(button(container, "Send"));
    await settle();
    expect(onFeedback).toHaveBeenCalledWith(expected);
    expect(container.textContent).toContain("Your feedback was sent.");
  });
});
