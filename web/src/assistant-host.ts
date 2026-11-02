/**
 * The Assistant tab: the query agent's larger control (`AgentWorkbench` from `@query-agent/react`),
 * mounted in the console.
 *
 * The browser drives the agent: an `AgentClient` runs the startup list and the agent's queries on
 * the console's own `IModelConnection`, and sends the turns to the agent function, whose URL the
 * console server gives (`IMOD_AGENT_FUNCTION_URL`).
 *
 * The control's feedback form is not shown: the console passes no `onFeedback`, as there is
 * nowhere to send feedback yet.
 */

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IModelConnection } from "@itwin/core-frontend";
import { AgentClient, queryRunner, type TurnRefused } from "@query-agent/client";
import { AgentWorkbench } from "@query-agent/react";
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
    this.session++;
    this.render();
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

