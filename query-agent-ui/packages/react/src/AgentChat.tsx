/**
 * The core control: the chat window and the ask box. A host starts an `AgentClient` for its open
 * iModel and passes it in; the control does the rest.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { TurnRefused, type AgentClient, type AgentRun, type AgentStatus } from "@query-agent/client";
import { contextOf, FAILED, type Chat, type ChatTurn } from "./chat";
import { Dots } from "./Dots";
import { FeedbackForm, type Feedback } from "./Feedback";

export interface AgentChatProps {
  /** The started client, or undefined when the agent is not set up. */
  client?: AgentClient;
  /** The text in the host's query editor, read when a question is asked. */
  editorText?: () => string | undefined;
  /** A chat to start from, such as one the host kept. */
  initialChat?: Chat;
  /** Called whenever the chat changes, so a host can keep it. */
  onChange?: (chat: Chat) => void;
  /** Called with each finished answer. */
  onAnswer?: (answer: { question: string; answer: string; query?: string; outcome?: string }) => void;
  /** Called with each finished run, whole. */
  onRunFinished?: (run: AgentRun, question: string) => void;
  /**
   * The function refused a question for a reason the user can act on (`TurnRefused`): 401 or 403
   * ask for an access key, 429 means the key is used up, 413 that the request is too long. The control shows the function's sentence;
   * a host can ask for a key here.
   */
  onRefused?: (refusal: TurnRefused) => void;
  /** Offered beside an answer's query: put it in the host's editor. */
  onUseQuery?: (ecsql: string) => void;
  /** When set, each answer has the feedback form, and what the user chooses to send goes here. */
  onFeedback?: (feedback: Feedback) => void | Promise<void>;
  /** Drawn under each finished answer, in place of the feedback form. */
  renderAfterAnswer?: (turn: ChatTurn, index: number) => ReactNode;
  /** Drawn after the questions. */
  renderAfterChat?: (chat: Chat, status: AgentStatus | undefined) => ReactNode;
  /** Called with each status and step while a run is in progress. */
  onStatus?: (status: AgentStatus | undefined) => void;
  placeholder?: string;
  /** Why there is no client, in place of saying the agent is not set up. */
  unavailable?: string;
  /** A question for the control to ask, as if typed: asked when `key` changes (a host's own "Ask" button). */
  question?: { text: string; key: string | number };
  /** The host's own buttons under each finished answer. */
  answerActions?: (turn: ChatTurn, index: number) => ReactNode;
}

/** What the user sees while the agent works. */
export function statusLabel(status: AgentStatus | undefined): string {
  switch (status?.phase) {
    case "exploring": return "Exploring";
    case "querying": return "Running a query";
    default: return "Thinking";
  }
}

export function AgentChat(props: AgentChatProps): JSX.Element {
  const { client, editorText, onChange, onAnswer, onRunFinished, onRefused, onUseQuery, onFeedback, renderAfterChat, onStatus } = props;
  const renderAfterAnswer = props.renderAfterAnswer
    ?? (onFeedback ? (turn: ChatTurn) => (turn.run ? <FeedbackForm turn={turn} onFeedback={onFeedback} /> : null) : undefined);
  const [chat, setChat] = useState<Chat>(props.initialChat ?? { turns: [] });
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<AgentStatus | undefined>();
  const [busy, setBusy] = useState(false);
  const stop = useRef<AbortController | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);

  const update = useCallback((next: Chat) => {
    setChat(next);
    onChange?.(next);
  }, [onChange]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [chat, status]);

  const report = (next: AgentStatus | undefined): void => {
    setStatus(next);
    onStatus?.(next);
  };

  const ask = async (asked?: string): Promise<void> => {
    const text = (asked ?? question).trim();
    if (!client || busy || text.length === 0)
      return;
    const controller = new AbortController();
    stop.current = controller;
    setBusy(true);
    setQuestion("");
    const before = chat;
    const asking: Chat = { turns: [...before.turns, { question: text, answer: "" }] };
    update(asking);
    let turn: ChatTurn;
    try {
      const run = await client.ask(text, {
        ...(await contextOf(before)),
        editorText: editorText?.(),
        signal: controller.signal,
        onStatus: report,
      });
      const outcome = run.structured?.outcome ?? run.stoppedBecause;
      turn = { question: text, answer: run.structured?.explanation ?? run.answer, query: run.structured?.query ?? run.query, outcome, run };
      onRunFinished?.(run, text);
      onAnswer?.({ question: text, answer: turn.answer, query: turn.query, outcome });
    } catch (err) {
      // A refusal the user can act on is shown as the function said it; anything else is a failure.
      if (err instanceof TurnRefused) {
        turn = { question: text, answer: "", error: err.message };
        onRefused?.(err);
      } else {
        turn = { question: text, answer: "", error: FAILED };
      }
    }
    update({ turns: [...before.turns, turn] });
    report(undefined);
    setBusy(false);
    stop.current = undefined;
  };

  // A question the host asks: once for each key, when the control is free.
  const hostQuestion = props.question;
  const askedKey = useRef<string | number | undefined>(undefined);
  useEffect(() => {
    if (!hostQuestion || hostQuestion.key === askedKey.current || !client || busy)
      return;
    askedKey.current = hostQuestion.key;
    void ask(hostQuestion.text);
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter asks; Shift+Enter is a new line. A question is usually one line.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void ask();
    }
  };

  return (
    <div className="qa-chat">
      <div className="qa-messages" aria-live="polite">
        {!client && <div className="qa-notice">{props.unavailable ?? "The agent is not set up."}</div>}
        {chat.turns.map((turn, index) => (
          <div className="qa-turn" key={index}>
            <div className="qa-question">{turn.question}</div>
            {turn.error
              ? <div className="qa-error">{turn.error}</div>
              : turn.run || turn.answer
                ? (
                  <div className="qa-answer">
                    <div className="qa-answer-text">{turn.answer}</div>
                    {turn.query && (
                      <div className="qa-query">
                        <pre><code>{turn.query}</code></pre>
                        {onUseQuery && <button type="button" onClick={() => onUseQuery(turn.query!)}>Use this query</button>}
                      </div>
                    )}
                    {props.answerActions && <div className="qa-answer-actions">{props.answerActions(turn, index)}</div>}
                    {renderAfterAnswer?.(turn, index)}
                  </div>
                )
                : (
                  <div className="qa-progress" role="status">
                    {statusLabel(status)}<Dots />
                  </div>
                )}
          </div>
        ))}
        {renderAfterChat?.(chat, status)}
        <div ref={end} />
      </div>
      <div className="qa-compose">
        <textarea
          className="qa-input"
          rows={3}
          value={question}
          disabled={!client || busy}
          placeholder={props.placeholder ?? "Ask for a query. Enter to send, Shift+Enter for a new line."}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="qa-controls">
          <button type="button" onClick={() => update({ turns: [] })} disabled={busy}>New chat</button>
          {busy
            ? <button type="button" onClick={() => stop.current?.abort()}>Stop</button>
            : <button type="button" onClick={() => void ask()} disabled={!client || question.trim().length === 0}>Ask</button>}
        </div>
      </div>
    </div>
  );
}
