/**
 * The larger control: the chat, with the answer's results and the earlier chats of this page
 * beside it. It has no query editor of its own: a query goes to the host's editor (`onUseQuery`).
 */

import { useState } from "react";
import type { AnswerRows, ResultPages } from "@query-agent/client";
import { ResultsTable } from "./ResultsTable";
import { AgentChat, type AgentChatProps } from "./AgentChat";
import type { Chat } from "./chat";

export type AgentWorkbenchProps = Omit<AgentChatProps, "renderAfterAnswer" | "renderAfterChat" | "initialChat"> & {
  /**
   * Show the last answer's results in a Results tab beside the chat. True by default. A host that
   * shows them elsewhere (with `AnswerResults`, from `onChange`) sets it to false.
   */
  showResults?: boolean;
};

type Tab = "results" | "history";

/** The last answer's results in a chat, or undefined when no answer has finished. */
export function lastAnswer(chat: Chat): { question: string; rows?: AnswerRows; results?: ResultPages } | undefined {
  const last = [...chat.turns].reverse().find((turn) => turn.run);
  return last && { question: last.question, rows: last.run?.answerRows, results: last.run?.results };
}

/**
 * An answer's results, with no row limit: a virtualized table (`ResultsTable`) that reads its rows
 * a page at a time from `results` as it scrolls, starting from the rows the client first read.
 */
export function AnswerResults(props: { rows?: AnswerRows; results?: ResultPages }): JSX.Element {
  return <ResultsTable rows={props.rows} results={props.results} />;
}

export function AgentWorkbench(props: AgentWorkbenchProps): JSX.Element {
  const { client, onChange, showResults = true, ...chatProps } = props;
  const [chat, setChat] = useState<Chat>({ turns: [] });
  const [history, setHistory] = useState<Chat[]>([]);
  const [opened, setOpened] = useState<{ chat: Chat; key: number }>({ chat: { turns: [] }, key: 0 });
  const tabs: Tab[] = showResults ? ["results", "history"] : ["history"];
  const [chosen, setTab] = useState<Tab>("results");
  const tab = tabs.includes(chosen) ? chosen : tabs[0];

  const changed = (next: Chat): void => {
    // "New chat" empties the chat: the one before goes into the history.
    if (next.turns.length === 0 && chat.turns.length > 0)
      setHistory((earlier) => [chat, ...earlier]);
    setChat(next);
    onChange?.(next);
  };

  const reopen = (earlier: Chat): void => {
    setHistory((list) => [...(chat.turns.length > 0 ? [chat] : []), ...list.filter((item) => item !== earlier)]);
    setChat(earlier);
    onChange?.(earlier);
    setOpened({ chat: earlier, key: opened.key + 1 });
  };

  return (
    <div className="qa-workbench-frame">
    <div className="qa-workbench">
      <div className="qa-workbench-chat">
        <AgentChat
          key={opened.key}
          {...chatProps}
          client={client}
          initialChat={opened.chat}
          onChange={changed}
        />
      </div>
      <div className="qa-workbench-side">
        <div className="qa-tabs" role="tablist">
          {tabs.map((name) => (
            <button type="button" role="tab" aria-selected={tab === name} key={name} onClick={() => setTab(name)}>
              {{ results: "Results", history: "History" }[name]}
            </button>
          ))}
        </div>
        {tab === "results" && <AnswerResults rows={lastAnswer(chat)?.rows} results={lastAnswer(chat)?.results} />}
        {tab === "history" && (
          <ul className="qa-history">
            {history.map((earlier, i) => (
              <li key={i}><button type="button" onClick={() => reopen(earlier)}>{earlier.turns[0]?.question ?? "(empty)"}</button></li>
            ))}
            {history.length === 0 && <li className="qa-muted">No earlier chats.</li>}
          </ul>
        )}
      </div>
    </div>
    </div>
  );
}
