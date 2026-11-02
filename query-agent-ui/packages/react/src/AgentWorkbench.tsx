/**
 * The larger control: the chat, with the answer's results and the earlier chats of this page
 * beside it. It has no query editor of its own: a query goes to the host's editor (`onUseQuery`).
 */

import { useState } from "react";
import type { AnswerRows } from "@query-agent/client";
import { AgentChat, type AgentChatProps } from "./AgentChat";
import type { Chat } from "./chat";

export type AgentWorkbenchProps = Omit<AgentChatProps, "renderAfterAnswer" | "renderAfterChat" | "initialChat">;

type Tab = "results" | "history";

function ResultsTable(props: { rows?: AnswerRows }): JSX.Element {
  if (props.rows?.error !== undefined)
    return <div className="qa-error">{props.rows.error}</div>;
  if (!props.rows)
    return <div className="qa-muted">No results yet.</div>;
  const { columns = [], rows = [], truncatedBy } = props.rows;
  return (
    <div className="qa-results">
      <table>
        <thead><tr>{columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{row.map((value, c) => <td key={c}>{value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value)}</td>)}</tr>)}</tbody>
      </table>
      {truncatedBy && <div className="qa-muted">Showing the first {rows.length} rows.</div>}
    </div>
  );
}

export function AgentWorkbench(props: AgentWorkbenchProps): JSX.Element {
  const { client, onChange, ...chatProps } = props;
  const [chat, setChat] = useState<Chat>({ turns: [] });
  const [history, setHistory] = useState<Chat[]>([]);
  const [opened, setOpened] = useState<{ chat: Chat; key: number }>({ chat: { turns: [] }, key: 0 });
  const [tab, setTab] = useState<Tab>("results");

  // The answer's results: read by the client once, when the run ended.
  const last = [...chat.turns].reverse().find((turn) => turn.run);

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
          {(["results", "history"] as Tab[]).map((name) => (
            <button type="button" role="tab" aria-selected={tab === name} key={name} onClick={() => setTab(name)}>
              {{ results: "Results", history: "History" }[name]}
            </button>
          ))}
        </div>
        {tab === "results" && <ResultsTable rows={last?.run?.answerRows} />}
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
