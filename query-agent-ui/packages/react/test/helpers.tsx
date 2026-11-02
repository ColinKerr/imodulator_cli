import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import type { RawQueryResult, TurnRequest, TurnResponse } from "@query-agent/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function mount(element: ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

export async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export function click(element: Element | null | undefined): void {
  if (!element)
    throw new Error("nothing to click");
  act(() => (element as HTMLElement).click());
}

export function type(textarea: HTMLTextAreaElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label);
}

export function rows(data: unknown[][]): RawQueryResult {
  return { columns: ["n"], rows: (async function* () { yield* data; })() };
}

export const CAPS = { maxRows: 200, maxChars: 12_000, maxCellChars: 400 };

let sealed = 0;

/** A response: the queries to run, or the end of the run with an answer. Each has a new opaque token. */
export function response(queries: string[], done?: { answer: string; query?: string; outcome?: string }): TurnResponse {
  sealed++;
  return {
    token: `sealed-${sealed}`, queries, caps: CAPS,
    ...(done ? {
      done: {
        answer: done.answer, ...(done.query ? { query: done.query } : {}), stoppedBecause: "answered", runId: `run-${sealed}`,
        ...(done.outcome ? { structured: { explanation: done.answer, query: done.query ?? "", outcome: done.outcome as "answered", rowLimitIntended: false } } : {}),
      },
    } : {}),
  };
}

/** Turns from a script; each waits for `gate` when one is given, so a test can look mid-run. */
export function scriptedTurns(script: TurnResponse[], gate?: () => Promise<void>): ((request: TurnRequest) => Promise<TurnResponse>) & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  const turn = (async (request: TurnRequest) => {
    requests.push(JSON.parse(JSON.stringify(request)) as TurnRequest);
    if (gate)
      await gate();
    if (request.aborted)
      return response([], { answer: "Stopped." });
    const next = script.shift();
    if (!next)
      throw new Error("out of script");
    return next;
  }) as ((request: TurnRequest) => Promise<TurnResponse>) & { requests: TurnRequest[] };
  turn.requests = requests;
  return turn;
}
