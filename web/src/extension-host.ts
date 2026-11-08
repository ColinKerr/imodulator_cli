/**
 * The console's side of the extension API (`extension-api.ts`): the API built from the console's
 * parts. Its parts are parameters, so it can be tested without the editor or an iModel.
 */

import {
  CONSOLE_EXTENSION_API_VERSION,
  type AnswerAction, type AnswerTurn, type ConsoleExtensionApi, type FeedbackHandler, type PanelTab, type QuerySample,
} from "./extension-api";

/** What `runQuery` reads rows with: the part of an iTwin.js `ECSqlReader` it uses. */
export interface SampleReader {
  getMetaData(): Promise<{ name: string }[]>;
  step(): Promise<boolean>;
  readonly current: { toArray(): unknown[] };
}

export interface ExtensionHostParts {
  panel: {
    addTab(tab: PanelTab): void;
    open(id: string): Promise<void>;
  };
  editor: {
    value(): string;
    setValue(text: string): void;
    run(): Promise<void>;
  };
  imodel: {
    current(): string | undefined;
    open(key: string): Promise<void>;
  };
  /** A reader for a query on the open iModel, or undefined when none is open. */
  createReader(ecsql: string): SampleReader | undefined;
  assistant: {
    readonly ready: boolean;
    ask(question: string): void;
    addAnswerAction(action: (turn: AnswerTurn) => AnswerAction | undefined): void;
    setFeedbackHandler(handler: FeedbackHandler | undefined): void;
  };
  setStatus(message: string, kind: "info" | "warning"): void;
}

/** Rows counted by `runQuery` when the caller sets no limit. */
export const DEFAULT_MAX_ROWS = 100_000;
/** Rows kept as a sample when the caller sets no number. */
export const DEFAULT_SAMPLE_ROWS = 20;

export interface ExtensionHost {
  api: ConsoleExtensionApi;
  /** Tell the extensions that an iModel was opened. */
  imodelChanged(key: string | undefined): void;
}

export function createExtensionHost(parts: ExtensionHostParts): ExtensionHost {
  const imodelListeners: ((key: string | undefined) => void)[] = [];

  const runQuery = async (ecsql: string, options: { maxRows?: number; sampleRows?: number } = {}): Promise<QuerySample> => {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const sampleSize = options.sampleRows ?? DEFAULT_SAMPLE_ROWS;
    try {
      const reader = parts.createReader(ecsql);
      if (!reader)
        return { ok: false, error: "No iModel is open." };
      const columns = (await reader.getMetaData()).map((column) => column.name);
      const sampleRows: unknown[][] = [];
      let rowCount = 0;
      let complete = true;
      while (await reader.step()) {
        if (rowCount >= maxRows) {
          complete = false;
          break;
        }
        if (rowCount < sampleSize)
          sampleRows.push(reader.current.toArray());
        rowCount++;
      }
      return { ok: true, columns, rowCount, complete, sampleRows };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const api: ConsoleExtensionApi = {
    apiVersion: CONSOLE_EXTENSION_API_VERSION,
    addPanelTab: (tab) => parts.panel.addTab(tab),
    showPanelTab: (id) => parts.panel.open(id),
    editor: {
      getText: () => parts.editor.value(),
      setText: (text) => parts.editor.setValue(text),
      run: () => parts.editor.run(),
    },
    imodel: {
      current: () => parts.imodel.current(),
      open: (key) => parts.imodel.open(key),
      onChange: (listener) => {
        imodelListeners.push(listener);
      },
    },
    runQuery,
    assistant: {
      ready: () => parts.assistant.ready,
      ask: async (question) => {
        await parts.panel.open("assistant");
        parts.assistant.ask(question);
      },
      addAnswerAction: (action) => parts.assistant.addAnswerAction(action),
      setFeedbackHandler: (handler) => parts.assistant.setFeedbackHandler(handler),
    },
    setStatus: (message, kind = "info") => parts.setStatus(message, kind),
  };

  return {
    api,
    imodelChanged: (key) => {
      for (const listener of imodelListeners) {
        try {
          listener(key);
        } catch (err) {
          console.error(err);
        }
      }
    },
  };
}
