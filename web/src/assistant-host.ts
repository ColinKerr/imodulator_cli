/**
 * The Assistant tab: the query agent's larger control (`AgentWorkbench` from `@query-agent/react`),
 * mounted in the console.
 *
 * The browser drives the agent: an `AgentClient` runs the startup list and the agent's queries on
 * the console's own `IModelConnection`, and sends the turns to the agent function, whose URL the
 * console server gives (`IMOD_AGENT_FUNCTION_URL`).
 *
 * The console itself has nowhere to send feedback, so the control's feedback form is shown only
 * while an extension has set a feedback handler. Extensions can also ask a question and add
 * buttons under each answer (`extension-api.ts`).
 */

import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IModelConnection } from "@itwin/core-frontend";
import { AgentClient, queryRunner, type AgentRun, type TurnRefused } from "@query-agent/client";
import { AgentWorkbench, type ChatTurn, type Feedback } from "@query-agent/react";
import type { AnswerAction, AnswerTurn, FeedbackHandler } from "./extension-api";
import "@query-agent/react/styles.css";

export interface AssistantHostCallbacks {
  /** What is in the query editor, sent as context. */
  editorText(): string;
  /** Put a query into the editor. */
  insertQuery(ecsql: string): void;
}

export class AssistantHost {
  private readonly root: Root;
  private functionUrl?: string;
  /** Whether the function answered `GET /turn`; undefined until checked. */
  private reachable?: boolean;
  private imodel?: IModelConnection;
  private imodelKey?: string;
  private client?: AgentClient;
  /** Changes with the iModel, so the control starts a new chat for each file. */
  private session = 0;
  private accessKey: string | undefined = readStoredKey();
  private readonly keyBox: KeyBox;
  /** A question to ask as if typed, until the chat it was asked in is replaced. */
  private question?: { text: string; key: number };
  private questions = 0;
  private readonly answerActions: ((turn: AnswerTurn) => AnswerAction | undefined)[] = [];
  private feedbackHandler?: FeedbackHandler;
  /** The finished runs of this page, newest last, to say which answer a feedback is about. */
  private readonly finished: AnswerTurn[] = [];

  constructor(container: HTMLElement, private readonly autoReplace: HTMLInputElement, private readonly host: AssistantHostCallbacks) {
    this.keyBox = createKeyBox(container, (key) => this.saveKey(key));
    this.root = createRoot(container);
    this.render();
  }

  /** A new key: kept for next time, and a new chat, since a chat stays with the key it began under. */
  private saveKey(key: string): void {
    this.accessKey = key;
    storeKey(key);
    this.keyBox.hide();
    if (this.client) {
      this.question = undefined;
      this.session++;
      this.render();
    } else {
      this.restart();
    }
  }

  /** The function refused a question: for a missing, wrong, removed or used-up key, ask for one. */
  private refused(refusal: TurnRefused): void {
    if (refusal.status === 401 || refusal.status === 403 || refusal.status === 429)
      this.keyBox.show(refusal.message);
  }

  /** Where the agent function is, from the console server's `/config.json`. */
  public async setFunctionUrl(functionUrl: string | undefined): Promise<void> {
    this.functionUrl = functionUrl;
    this.reachable = undefined;
    // Asked at once, before any iModel and without waiting on the function, which may be waking from zero.
    if (this.waitingForKey())
      this.keyBox.show(NEEDS_KEY);
    this.render();
    if (functionUrl) {
      try {
        this.reachable = (await fetch(`${functionUrl.replace(/\/+$/, "")}/turn`)).ok;
      } catch {
        this.reachable = false;
      }
    }
    this.restart();
  }

  /** The iModel the console opened. The agent's findings are about one file, so this starts a new chat. */
  public setIModel(imodel: IModelConnection | undefined, key: string | undefined): void {
    this.imodel = imodel;
    this.imodelKey = key;
    this.restart();
  }

  /** A new client for the open iModel: starting it runs the startup list at once. */
  private restart(): void {
    // Starting a client runs the startup list, which waits until there is a key to use it with.
    this.client = this.functionUrl && this.reachable && !this.waitingForKey()
      ? AgentClient.start({
        runQuery: this.imodel ? queryRunner(this.imodel) : undefined,
        imodelName: this.imodel ? this.imodelKey : undefined,
        functionUrl: this.functionUrl,
        // Read at every turn, so a key given later is used without starting the client again.
        getAccessToken: async () => this.accessKey,
      })
      : undefined;
    // A question asked in the chat being replaced is not asked again in the new one.
    this.question = undefined;
    this.session++;
    this.render();
  }

  /** Whether a question can be answered now. */
  public get ready(): boolean {
    return this.client !== undefined;
  }

  /** Ask a question as if the user typed it. Asked once the agent is free. */
  public ask(text: string): void {
    this.question = { text, key: ++this.questions };
    this.render();
  }

  /** Offer a button under each finished answer. */
  public addAnswerAction(action: (turn: AnswerTurn) => AnswerAction | undefined): void {
    this.answerActions.push(action);
    this.render();
  }

  /** Where the feedback form sends; the form shows only while one is set. */
  public setFeedbackHandler(handler: FeedbackHandler | undefined): void {
    this.feedbackHandler = handler;
    this.render();
  }

  private answerTurn(turn: ChatTurn): AnswerTurn {
    return {
      question: turn.question,
      answer: turn.answer,
      ...(turn.query ? { query: turn.query } : {}),
      ...(turn.outcome ? { outcome: turn.outcome } : {}),
      ...(turn.run ? { runId: turn.run.runId } : {}),
      ...(this.imodelKey ? { imodelKey: this.imodelKey } : {}),
    };
  }

  private runFinished(run: AgentRun, question: string): void {
    // The answer and query as the chat shows them (`AgentChat`): the submitted ones, when the run submitted.
    const query = run.structured?.query ?? run.query;
    this.finished.push({
      question,
      answer: run.structured?.explanation ?? run.answer,
      ...(query ? { query } : {}),
      outcome: run.stoppedBecause,
      runId: run.runId,
      ...(this.imodelKey ? { imodelKey: this.imodelKey } : {}),
    });
  }

  /** The buttons under one answer: each extension's, for the answers that have a run. */
  private actionsFor(turn: ChatTurn): ReactNode {
    if (!turn.run)
      return null;
    const answer = this.answerTurn(turn);
    const actions = this.answerActions.map((action) => {
      try {
        return action(answer);
      } catch (err) {
        console.error(err);
        return undefined;
      }
    }).filter((action): action is AnswerAction => action !== undefined);
    return actions.map((action, index) => createElement("button", {
      key: index,
      type: "button",
      className: "assistant-answer-action",
      title: action.title,
      onClick: () => void Promise.resolve().then(() => action.onClick()).catch((err) => console.error(err)),
    }, action.label));
  }

  private sendFeedback(feedback: Feedback): void | Promise<void> {
    // The form names the answer by its question and text. The run is the latest with both; the
    // chat may show the answer's text tidied, so failing that, the latest with the question.
    const newestFirst = [...this.finished].reverse();
    const turn = newestFirst.find((item) => item.question === feedback.question && item.answer === feedback.answer)
      ?? newestFirst.find((item) => item.question === feedback.question)
      ?? { question: feedback.question, answer: feedback.answer, ...(this.imodelKey ? { imodelKey: this.imodelKey } : {}) };
    return this.feedbackHandler?.(feedback, turn);
  }

  private waitingForKey(): boolean {
    return Boolean(this.functionUrl) && !this.accessKey;
  }

  private render(): void {
    this.root.render(createElement(AgentWorkbench, {
      key: this.session,
      client: this.client,
      editorText: () => this.host.editorText(),
      placeholder: this.client
        ? (this.imodelKey ? `Ask for a query against ${this.imodelKey}. Enter to send, Shift+Enter for a new line.` : "No iModel is open: ask about ECSql itself.")
        : undefined,
      unavailable: this.waitingForKey() ? NEEDS_KEY : undefined,
      onUseQuery: (ecsql: string) => this.host.insertQuery(ecsql),
      onAnswer: ({ query }) => {
        if (query && this.autoReplace.checked)
          this.host.insertQuery(query);
      },
      onRefused: (refusal: TurnRefused) => this.refused(refusal),
      onRunFinished: (run: AgentRun, question: string) => this.runFinished(run, question),
      ...(this.question ? { question: this.question } : {}),
      ...(this.answerActions.length > 0 ? { answerActions: (turn: ChatTurn) => this.actionsFor(turn) } : {}),
      ...(this.feedbackHandler ? { onFeedback: (feedback: Feedback) => this.sendFeedback(feedback) } : {}),
    }));
  }
}

const NEEDS_KEY = "Enter your access key to ask the agent.";

/** Where the access key is kept in this browser. */
const KEY_STORAGE = "query-agent.access-key";

function readStoredKey(): string | undefined {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? undefined;
  } catch {
    // Storage can be blocked; the user is asked again instead.
    return undefined;
  }
}

function storeKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // Kept for this page only.
  }
}

interface KeyBox {
  show(message: string): void;
  hide(): void;
}

/** The access key box, above the chat: hidden until a key is needed. */
function createKeyBox(container: HTMLElement, save: (key: string) => void): KeyBox {
  const box = document.createElement("form");
  box.className = "assistant-key";
  box.hidden = true;
  const message = document.createElement("div");
  message.className = "assistant-key-message";
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "Access key (qak_…)";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Access key");
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Use this key";
  const row = document.createElement("div");
  row.className = "assistant-key-row";
  row.append(input, button);
  const dataNote = document.createElement("div");
  dataNote.className = "assistant-key-message";
  dataNote.textContent = "Your question, editor text, iModel name and query rows are sent to the agent function and to Anthropic.";
  box.append(message, row, dataNote);
  box.addEventListener("submit", (event) => {
    event.preventDefault();
    const key = input.value.trim();
    if (key) {
      input.value = "";
      save(key);
    }
  });
  container.before(box);
  return {
    show(text: string) {
      message.textContent = text;
      box.hidden = false;
      input.focus();
    },
    hide() {
      box.hidden = true;
    },
  };
}

