/**
 * The console's extension API.
 *
 * An extension is a JavaScript module named in `IMOD_CONSOLE_EXTENSIONS` (see the README). The
 * console imports it after it starts and calls its `activate` with this API. An extension runs in
 * the console page with all of the page's rights, so only load files you trust.
 *
 * The API changes only with its version: a module that exports `apiVersion` is loaded only by a
 * console with that version.
 */

/** The version of this API. */
export const CONSOLE_EXTENSION_API_VERSION = 1;

/** What an extension module exports. */
export interface ConsoleExtension {
  /** The API version the extension was written for. Optional; checked when present. */
  apiVersion?: number;
  /** Called once, after the console has started. */
  activate(api: ConsoleExtensionApi): void | Promise<void>;
}

export interface ConsoleExtensionApi {
  readonly apiVersion: typeof CONSOLE_EXTENSION_API_VERSION;

  /** Add a tab to the side panel, after the console's own tabs. */
  addPanelTab(tab: PanelTab): void;
  /** Open the side panel on a tab: the console's (`"reference"`, `"assistant"`) or one added. */
  showPanelTab(id: string): Promise<void>;

  /** The query editor. */
  readonly editor: {
    /** The editor's whole text. */
    getText(): string;
    /** Replace the editor's text. */
    setText(text: string): void;
    /** Run the editor's query into the results table, as the Run button does. */
    run(): Promise<void>;
  };

  /** The open iModel. */
  readonly imodel: {
    /** The key of the open iModel, if one is open. */
    current(): string | undefined;
    /** Open an iModel by key or file path, as the picker does. */
    open(key: string): Promise<void>;
    /** Told after each iModel is opened, with its key. */
    onChange(listener: (key: string | undefined) => void): void;
  };

  /**
   * Run a query on the open iModel without touching the results table: whether it ran, how many
   * rows it returned (counted up to `maxRows`), and the first rows.
   */
  runQuery(ecsql: string, options?: { maxRows?: number; sampleRows?: number }): Promise<QuerySample>;

  /** The Assistant tab. */
  readonly assistant: {
    /** Whether the Assistant can answer now: the agent is reachable and has what it needs. */
    ready(): boolean;
    /** Open the Assistant tab and ask a question, as if the user typed it. */
    ask(question: string): Promise<void>;
    /** Offer a button under each finished answer. Return undefined to offer none for that answer. */
    addAnswerAction(action: (turn: AnswerTurn) => AnswerAction | undefined): void;
    /**
     * Where the feedback form under each answer sends what the user chooses to send. The form is
     * shown only while a handler is set.
     */
    setFeedbackHandler(handler: FeedbackHandler | undefined): void;
  };

  /** Show a message in the console's status line. */
  setStatus(message: string, kind?: "info" | "warning"): void;
}

export interface PanelTab {
  /** Unique among the panel's tabs. */
  id: string;
  /** The tab's text. */
  label: string;
  /** Wider than the reference, as the Assistant is. */
  wide?: boolean;
  /** Called once, the first time the tab is shown, with the tab's own element to fill. */
  mount(container: HTMLElement): void;
  /** Called each time the tab is shown, after `mount`. */
  onShow?(): void;
}

export interface QuerySample {
  ok: boolean;
  error?: string;
  columns?: string[];
  /** Rows counted, up to the limit. */
  rowCount?: number;
  /** Whether `rowCount` is every row, rather than the limit. */
  complete?: boolean;
  sampleRows?: unknown[][];
}

/** A finished answer of the Assistant. */
export interface AnswerTurn {
  question: string;
  answer: string;
  query?: string;
  /** How the run ended, as the agent reports it. */
  outcome?: string;
  /** The run's id, as the agent function returned it. */
  runId?: string;
  /** The key of the iModel the question was asked on. */
  imodelKey?: string;
}

export interface AnswerAction {
  label: string;
  title?: string;
  onClick(): void | Promise<void>;
}

/** The feedback the user chose to send on one answer, with the answer it is about. */
export interface AnswerFeedback {
  question: string;
  answer: string;
  query?: string;
  rating: "right" | "partly" | "wrong";
  correctedAnswer?: string;
  correctedQuery?: string;
  comment?: string;
}

export type FeedbackHandler = (feedback: AnswerFeedback, turn: AnswerTurn) => void | Promise<void>;
