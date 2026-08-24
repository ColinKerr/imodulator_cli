import type { IModelConnection } from "@itwin/core-frontend";
import type { ECSqlReader } from "@itwin/core-common";
import { createEditor } from "./editor";
import { ResultsTable } from "./results-table";
import { countQuery, explainQuery, toCsv, type ColumnInfo } from "./query-shape";
import { emptySchemaInfo, loadSchemaInfo, type SchemaInfo } from "./schema-info";
import { readChunk } from "./paging";
import { listIModels, loadConfig, openIModel, startFrontend, type ConsoleConfig } from "./connection";

/**
 * Rows appended per fetch. The reader pages from the server itself, so this only decides how
 * much is pulled forward at a time as the user scrolls.
 */
const PAGE_ROWS = 1_000;

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element)
    throw new Error(`missing element: ${id}`);
  return element;
};

class Console {
  private readonly editor = createEditor($("editor"));
  private readonly table = new ResultsTable($("results"));
  private readonly history: string[] = [];
  private historyAt = -1;
  private imodel?: IModelConnection;
  private schemaInfo: SchemaInfo = emptySchemaInfo();
  private lastColumns: ColumnInfo[] = [];
  /**
   * The reader for the query on screen, kept alive so scrolling can pull further pages. It
   * holds the server side cursor: each `step` resumes where the last one stopped.
   */
  private reader?: ECSqlReader;
  private readerDone = false;
  private config: ConsoleConfig = { backendRunning: false };
  /** True once the count query has reported the real total. */
  private countIsExact = false;

  public async start(): Promise<void> {
    this.config = await loadConfig();
    this.wireUi();

    if (!this.config.backendRunning || !this.config.backendUrl) {
      this.warn("No backend is running. Start one with:  imod serve backend");
      this.setEnabled(false);
      return;
    }

    await startFrontend(this.config.backendUrl);
    if (this.config.imodelPath)
      await this.open(this.config.imodelPath);
    this.updateButtons();
  }

  private wireUi(): void {
    $("run").addEventListener("click", () => void this.run());
    $("explain").addEventListener("click", () => void this.run(true));
    $("format").addEventListener("click", () => this.editor.format());
    $("save").addEventListener("click", () => this.saveCsv());
    $("pick").addEventListener("click", () => void this.showPicker());
    $("back").addEventListener("click", () => this.step(-1));
    $("forward").addEventListener("click", () => this.step(1));
    this.editor.onChange(() => this.updateButtons());
    this.table.setRowsLoadedListener((total) => {
      this.updateButtons();
      if (this.countIsExact)
        return;
      $("count").textContent = `Count: ${total}+`;
    });
    this.editor.onRun(() => void this.run());
    this.setupSplitter();
    window.addEventListener("resize", () => this.editor.layout());
    this.editor.layout();
  }

  private setEnabled(enabled: boolean): void {
    for (const id of ["run", "explain", "format", "save"])
      ($(id) as HTMLButtonElement).disabled = !enabled;
  }

  private updateButtons(): void {
    const hasText = this.editor.value().trim().length > 0;
    const connected = this.imodel !== undefined;
    ($("run") as HTMLButtonElement).disabled = !hasText || !connected;
    ($("explain") as HTMLButtonElement).disabled = !hasText || !connected;
    ($("format") as HTMLButtonElement).disabled = !hasText;
    ($("save") as HTMLButtonElement).disabled = this.table.rowCount === 0;
    ($("back") as HTMLButtonElement).disabled = this.historyAt <= 0;
    ($("forward") as HTMLButtonElement).disabled = this.historyAt >= this.history.length - 1;
  }

  private warn(message: string): void {
    const status = $("status");
    status.textContent = message;
    status.className = "status warning";
  }

  private status(message: string): void {
    const status = $("status");
    status.textContent = message;
    status.className = "status";
  }

  private async showPicker(): Promise<void> {
    if (!this.config.backendUrl)
      return;
    const dialog = $("picker") as HTMLDialogElement;
    const list = $("picker-list");
    list.replaceChildren();

    try {
      const { open, available } = await listIModels(this.config.backendUrl);
      const seen = new Set<string>();
      for (const entry of [...open, ...available]) {
        if (seen.has(entry.key))
          continue;
        seen.add(entry.key);
        const button = document.createElement("button");
        button.className = "picker-entry";
        button.innerHTML = `<span class="picker-key">${entry.key}</span><span class="picker-path">${entry.filePath}</span>`;
        button.addEventListener("click", () => {
          dialog.close();
          void this.open(entry.key);
        });
        list.appendChild(button);
      }
      if (seen.size === 0)
        list.textContent = "No iModels are open or in the cache. Paste a file path below.";
    } catch (err) {
      list.textContent = err instanceof Error ? err.message : String(err);
    }

    dialog.showModal();
    ($("picker-open") as HTMLButtonElement).onclick = () => {
      const path = ($("picker-path-input") as HTMLInputElement).value.trim();
      if (path.length === 0)
        return;
      dialog.close();
      void this.open(path);
    };
  }

  private async open(key: string): Promise<void> {
    if (!this.config.backendUrl)
      return;
    this.status(`Opening ${key}...`);
    try {
      await this.imodel?.close();
      this.imodel = await openIModel(this.config.backendUrl, key);
      $("imodel-name").textContent = key;
      this.status(`Reading schemas...`);
      this.schemaInfo = await loadSchemaInfo(this.imodel);
      this.editor.setSchemaInfo(this.schemaInfo);
      this.status(`Opened ${key}`);
    } catch (err) {
      this.warn(err instanceof Error ? err.message : String(err));
    }
    this.updateButtons();
  }

  private async run(explain = false): Promise<void> {
    if (!this.imodel)
      return;
    const ecsql = this.editor.textToRun();
    if (ecsql.length === 0)
      return;

    this.remember(ecsql);
    this.status(explain ? "Explaining..." : "Running...");
    $("count").textContent = "";

    try {
      const toRun = explain ? explainQuery(ecsql) : ecsql;
      this.reader = this.imodel.createQueryReader(toRun);
      this.readerDone = false;
      const rows = await this.readChunk(PAGE_ROWS);
      const metadata = await this.reader.getMetaData();
      const columns: ColumnInfo[] = metadata.map((column) => ({
        name: column.name,
        jsonName: column.jsonName,
        typeName: column.typeName,
        extendedType: column.extendedType,
        className: column.className,
      }));

      this.lastColumns = columns;
      this.table.setData({
        columns,
        rows,
        classNames: this.schemaInfo.classNamesById,
        loadMore: () => this.readChunk(PAGE_ROWS),
      });
      this.status(explain ? "Explained" : "Ran");
      this.updateButtons();

      this.countIsExact = false;
      if (!explain) {
        void this.updateCount(ecsql, rows.length);
      } else {
        this.countIsExact = true;
        $("count").textContent = `Count: ${rows.length}`;
      }
    } catch (err) {
      this.table.clear();
      this.reader = undefined;
      this.readerDone = true;
      this.warn(err instanceof Error ? err.message : String(err));
      this.updateButtons();
    }
  }

  /** Take the next rows from the live reader, or none once the query has run out. */
  private async readChunk(count: number): Promise<unknown[][]> {
    if (!this.reader || this.readerDone)
      return [];
    const chunk = await readChunk(this.reader, count);
    this.readerDone = chunk.done;
    return chunk.rows;
  }

  /**
   * The row count is the count of the whole query, not of the page fetched, so it is a
   * second query wrapping the first. It runs after the rows are on screen because it costs
   * a second execution.
   */
  private async updateCount(ecsql: string, fetched: number): Promise<void> {
    $("count").textContent = `Count: ${fetched}+ (counting...)`;
    try {
      const reader = this.imodel!.createQueryReader(countQuery(ecsql));
      for await (const row of reader) {
        this.countIsExact = true;
        $("count").textContent = `Count: ${row.toArray()[0]}`;
        return;
      }
    } catch {
      // Not every query can be wrapped -- a pragma cannot -- so fall back to rows loaded,
      // which the table keeps updating as more arrive.
    }
    $("count").textContent = `Count: ${this.table.rowCount}+`;
  }

  private remember(ecsql: string): void {
    if (this.history[this.historyAt] === ecsql)
      return;
    this.history.splice(this.historyAt + 1);
    this.history.push(ecsql);
    this.historyAt = this.history.length - 1;
  }

  private step(delta: number): void {
    const next = this.historyAt + delta;
    if (next < 0 || next >= this.history.length)
      return;
    this.historyAt = next;
    this.status(this.history[next]);
    this.updateButtons();
  }

  private saveCsv(): void {
    if (this.table.rowCount === 0)
      return;
    // What is written is what has been loaded; scrolling further loads more.
    const rows = [...this.table.rows];
    const csv = toCsv(this.lastColumns.map((column) => column.name), rows);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "results.csv";
    link.click();
    URL.revokeObjectURL(url);
    this.status(`Saved ${rows.length} row(s) to results.csv`);
  }

  private setupSplitter(): void {
    const divider = $("divider");
    const top = $("editor-pane");
    divider.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const move = (moveEvent: PointerEvent): void => {
        const bounds = $("content").getBoundingClientRect();
        const ratio = (moveEvent.clientY - bounds.top) / bounds.height;
        top.style.flexBasis = `${Math.min(90, Math.max(10, ratio * 100))}%`;
        this.editor.layout();
      };
      const done = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", done);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", done);
    });
  }
}

void new Console().start();
