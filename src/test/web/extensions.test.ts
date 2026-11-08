import { describe, expect, it, vi } from "vitest";
import { loadExtensions } from "../../../web/src/extensions";
import { createExtensionHost, type ExtensionHostParts, type SampleReader } from "../../../web/src/extension-host";
import type { AnswerAction, AnswerTurn, ConsoleExtensionApi, FeedbackHandler, PanelTab } from "../../../web/src/extension-api";

/** A reader over fixed rows, as a query on the open iModel would give. */
function readerOf(columns: string[], rows: unknown[][], failWith?: string): SampleReader {
  let at = -1;
  return {
    getMetaData: async () => {
      if (failWith)
        throw new Error(failWith);
      return columns.map((name) => ({ name }));
    },
    step: async () => ++at < rows.length,
    get current() {
      return { toArray: () => rows[at] };
    },
  };
}

/** Stand-ins for the console's parts, recording what the API asks of them. */
function fakeParts() {
  const calls: string[] = [];
  const tabs: PanelTab[] = [];
  const actions: ((turn: AnswerTurn) => AnswerAction | undefined)[] = [];
  let feedback: FeedbackHandler | undefined;
  let text = "SELECT 1";
  let key: string | undefined;
  let reader: SampleReader | undefined;
  const parts: ExtensionHostParts = {
    panel: {
      addTab: (tab) => tabs.push(tab),
      open: async (id) => {
        calls.push(`open tab ${id}`);
      },
    },
    editor: {
      value: () => text,
      setValue: (value) => {
        text = value;
      },
      run: async () => {
        calls.push(`run ${text}`);
      },
    },
    imodel: {
      current: () => key,
      open: async (value) => {
        key = value;
      },
    },
    createReader: () => reader,
    assistant: {
      ready: true,
      ask: (question) => calls.push(`ask ${question}`),
      addAnswerAction: (action) => actions.push(action),
      setFeedbackHandler: (handler) => {
        feedback = handler;
      },
    },
    setStatus: (message, kind) => calls.push(`${kind} ${message}`),
  };
  return {
    parts, calls, tabs, actions,
    feedback: () => feedback,
    setReader: (value: SampleReader | undefined) => {
      reader = value;
    },
  };
}

describe("loading console extensions", () => {
  const api = { apiVersion: 1 } as ConsoleExtensionApi;

  it("activates each module with the API, in order, whether it exports activate or a default", async () => {
    const order: string[] = [];
    const modules: Record<string, unknown> = {
      "./extensions/0.js": { activate: (given: unknown) => order.push(given === api ? "first" : "wrong api") },
      "./extensions/1.js": { default: { apiVersion: 1, activate: async () => order.push("second") } },
    };
    const problems = await loadExtensions(Object.keys(modules), api, async (url) => modules[url]);
    expect(problems).toEqual([]);
    expect(order).toEqual(["first", "second"]);
  });

  it("reports a module that fails to import, has no activate, wants another API or throws, and loads the rest", async () => {
    const loaded = vi.fn();
    const modules: Record<string, unknown> = {
      "./extensions/1.js": {},
      "./extensions/2.js": { apiVersion: 2, activate: loaded },
      "./extensions/3.js": { activate: () => {
        throw new Error("boom");
      } },
      "./extensions/4.js": { activate: loaded },
    };
    const problems = await loadExtensions(["./extensions/0.js", ...Object.keys(modules)], api, async (url) => {
      if (!(url in modules))
        throw new Error("Failed to fetch");
      return modules[url];
    });
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/0\.js failed: Failed to fetch/);
    expect(problems[1]).toMatch(/1\.js: it exports no activate function/);
    expect(problems[2]).toMatch(/2\.js: it was written for extension API 2; this console has 1/);
    expect(problems[3]).toMatch(/3\.js failed: boom/);
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it("loads nothing when there are no extensions", async () => {
    const importer = vi.fn();
    expect(await loadExtensions([], api, importer)).toEqual([]);
    expect(importer).not.toHaveBeenCalled();
  });
});

describe("the extension API", () => {
  it("reaches the editor, the iModel, the panel and the status line", async () => {
    const fake = fakeParts();
    const { api, imodelChanged } = createExtensionHost(fake.parts);
    expect(api.apiVersion).toBe(1);

    const mount = vi.fn();
    api.addPanelTab({ id: "extra", label: "Extra", mount });
    expect(fake.tabs.map((tab) => tab.id)).toEqual(["extra"]);
    await api.showPanelTab("extra");

    expect(api.editor.getText()).toBe("SELECT 1");
    api.editor.setText("SELECT 2");
    await api.editor.run();

    const seen: (string | undefined)[] = [];
    api.imodel.onChange((key) => seen.push(key));
    api.imodel.onChange(() => {
      throw new Error("a listener's failure stays its own");
    });
    await api.imodel.open("some-key");
    expect(api.imodel.current()).toBe("some-key");
    imodelChanged("some-key");
    expect(seen).toEqual(["some-key"]);

    api.setStatus("hello");
    api.setStatus("careful", "warning");
    expect(fake.calls).toEqual(["open tab extra", "run SELECT 2", "info hello", "warning careful"]);
  });

  it("asks the Assistant on its own tab, and passes answer actions and the feedback handler through", async () => {
    const fake = fakeParts();
    const { api } = createExtensionHost(fake.parts);
    expect(api.assistant.ready()).toBe(true);
    await api.assistant.ask("How many walls?");
    expect(fake.calls).toEqual(["open tab assistant", "ask How many walls?"]);

    api.assistant.addAnswerAction((turn) => (turn.runId ? { label: "Keep", onClick: () => {} } : undefined));
    expect(fake.actions).toHaveLength(1);
    expect(fake.actions[0]({ question: "q", answer: "a", runId: "r1" })?.label).toBe("Keep");
    expect(fake.actions[0]({ question: "q", answer: "a" })).toBeUndefined();

    const handler: FeedbackHandler = () => {};
    api.assistant.setFeedbackHandler(handler);
    expect(fake.feedback()).toBe(handler);
    api.assistant.setFeedbackHandler(undefined);
    expect(fake.feedback()).toBeUndefined();
  });

  it("runs a query for a sample, counting to the limit, without the results table", async () => {
    const fake = fakeParts();
    const { api } = createExtensionHost(fake.parts);

    expect(await api.runQuery("SELECT 1")).toEqual({ ok: false, error: "No iModel is open." });

    const rows = Array.from({ length: 30 }, (_value, i) => [i]);
    fake.setReader(readerOf(["n"], rows));
    expect(await api.runQuery("SELECT n", { sampleRows: 2 })).toEqual({ ok: true, columns: ["n"], rowCount: 30, complete: true, sampleRows: [[0], [1]] });

    fake.setReader(readerOf(["n"], rows));
    const capped = await api.runQuery("SELECT n", { maxRows: 10 });
    expect(capped.rowCount).toBe(10);
    expect(capped.complete).toBe(false);
    expect(capped.sampleRows).toHaveLength(10);

    fake.setReader(readerOf([], [], "no such class"));
    expect(await api.runQuery("SELECT x FROM y")).toEqual({ ok: false, error: "no such class" });
  });
});
