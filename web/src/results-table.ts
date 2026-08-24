import { augmentValue, columnKind, isExtraLong, isTruncated, type ColumnInfo, type ColumnKind } from "./query-shape";

/** Rows rendered outside the viewport, so scrolling does not flash empty space. */
const OVERSCAN = 10;
const ROW_HEIGHT = 24;
const MIN_COLUMN_WIDTH = 48;
/** The always present column on the left that holds a row's expand chevron. */
const GUTTER_WIDTH = 24;
const MAX_INITIAL_COLUMN_WIDTH = 420;
/** How much wider than its column the hover box is drawn. */
const HOVER_WIDTH_FACTOR = 1.5;

export interface TableData {
  columns: ColumnInfo[];
  rows: unknown[][];
  /** Class id to `Schema.Class`, used to annotate class id columns. */
  classNames: ReadonlyMap<string, string>;
  /**
   * Fetches the next rows from the server, or an empty array once the query is exhausted.
   * Called as the viewport approaches the last loaded row.
   */
  loadMore?: () => Promise<unknown[][]>;
}

/**
 * A virtualized table: only the visible rows exist in the DOM, so a result set of any size
 * renders in constant time.
 *
 * Hand rolled rather than pulled from a library, because the console has no other need for a
 * grid dependency and the behaviour wanted here is narrow.
 */
export class ResultsTable {
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly body: HTMLElement;
  private readonly header: HTMLElement;
  private readonly hover: HTMLElement;
  private data: TableData = { columns: [], rows: [], classNames: new Map() };
  private loading = false;
  private exhausted = false;
  private onRowsLoaded?: (total: number) => void;
  private widths: number[] = [];
  private kinds: ColumnKind[] = [];
  private expanded = new Set<number>();

  public constructor(private readonly root: HTMLElement) {
    this.root.classList.add("results");
    this.header = document.createElement("div");
    this.header.className = "results-header";
    this.viewport = document.createElement("div");
    this.viewport.className = "results-viewport";
    this.spacer = document.createElement("div");
    this.spacer.className = "results-spacer";
    this.body = document.createElement("div");
    this.body.className = "results-body";
    this.hover = document.createElement("div");
    this.hover.className = "results-hover";
    this.hover.hidden = true;
    this.spacer.appendChild(this.body);
    this.viewport.appendChild(this.spacer);
    this.root.append(this.header, this.viewport, this.hover);
    this.watchForHover();
    this.viewport.addEventListener("scroll", () => {
      // The header sits outside the scrolling viewport so it stays visible, which means its
      // horizontal position has to be driven from here or the columns drift out of line.
      this.header.scrollLeft = this.viewport.scrollLeft;
      // The hover is positioned against the cell, so scrolling would leave it stranded.
      this.hideHover();
      this.renderRows();
      void this.loadMoreIfNeeded();
    });
  }

  /**
   * Show the whole value of a truncated cell on hover, in a box half again as wide as the
   * column so the wrapped text has somewhere to go.
   *
   * Delegated rather than bound per cell: rows are rebuilt on every scroll, so listeners on
   * individual cells would be attached and discarded continuously.
   */
  private watchForHover(): void {
    this.viewport.addEventListener("pointerover", (event) => {
      const cell = (event.target as HTMLElement | null)?.closest?.(".results-cell") as HTMLElement | null;
      if (!cell || cell.dataset.truncated !== "1" || cell.closest(".results-row")?.classList.contains("expanded")) {
        this.hideHover();
        return;
      }
      this.showHover(cell);
    });
    this.viewport.addEventListener("pointerleave", () => this.hideHover());
  }

  private showHover(cell: HTMLElement): void {
    this.hover.replaceChildren(document.createTextNode(cell.dataset.value ?? ""));
    if (cell.dataset.annotation) {
      const note = document.createElement("span");
      note.className = "results-annotation";
      note.textContent = ` ${cell.dataset.annotation}`;
      this.hover.appendChild(note);
    }

    const bounds = cell.getBoundingClientRect();
    this.hover.style.width = `${bounds.width * HOVER_WIDTH_FACTOR}px`;
    this.hover.style.left = `${bounds.left}px`;
    this.hover.style.top = `${bounds.bottom}px`;
    this.hover.hidden = false;
  }

  private hideHover(): void {
    this.hover.hidden = true;
  }

  public get rowCount(): number {
    return this.data.rows.length;
  }

  /** Every row loaded so far, which is what "save results" writes. */
  public get rows(): readonly unknown[][] {
    return this.data.rows;
  }

  /** Called whenever more rows arrive, so the caller can report progress. */
  public setRowsLoadedListener(listener: (total: number) => void): void {
    this.onRowsLoaded = listener;
  }

  public setData(data: TableData): void {
    this.data = data;
    this.kinds = data.columns.map(columnKind);
    this.widths = this.measureColumns();
    this.expanded.clear();
    this.hideHover();
    this.loading = false;
    this.exhausted = data.loadMore === undefined;
    this.viewport.scrollTop = 0;
    this.renderHeader();
    this.sizeSpacer();
    this.renderRows();
    // The first page may not fill the viewport, in which case no scroll event will ever fire
    // to ask for the next one.
    void this.loadMoreIfNeeded();
  }

  /**
   * Pull the next rows when the viewport nears the end of what is loaded.
   *
   * The query reader is kept alive by the caller and pages from the server itself, so this
   * only has to ask for more; each call resumes where the last one stopped.
   */
  private async loadMoreIfNeeded(): Promise<void> {
    if (this.loading || this.exhausted || !this.data.loadMore)
      return;

    const loadedHeight = this.data.rows.length * ROW_HEIGHT;
    const nearEnd = this.viewport.scrollTop + this.viewport.clientHeight >= loadedHeight - ROW_HEIGHT * OVERSCAN * 2;
    if (!nearEnd)
      return;

    this.loading = true;
    this.root.classList.add("loading-more");
    try {
      const more = await this.data.loadMore();
      if (more.length === 0) {
        this.exhausted = true;
      } else {
        this.data.rows.push(...more);
        this.sizeSpacer();
        this.renderRows();
        this.onRowsLoaded?.(this.data.rows.length);
      }
    } catch {
      // A failed fetch must not spin: stop asking rather than retry on every scroll event.
      this.exhausted = true;
    } finally {
      this.loading = false;
      this.root.classList.remove("loading-more");
      // Loading a page may still leave the viewport near the end, so keep going until the
      // rows outrun the scroll position or the query runs out.
      if (!this.exhausted)
        void this.loadMoreIfNeeded();
    }
  }

  public clear(): void {
    this.setData({ columns: [], rows: [], classNames: new Map() });
  }

  /**
   * Size each column to its header and the first page of rows, which is what a user sees
   * first. Measuring every row of a large result would cost more than it is worth.
   */
  private measureColumns(): number[] {
    const sample = this.data.rows.slice(0, 100);
    return this.data.columns.map((column, index) => {
      let longest = column.name.length;
      for (const row of sample) {
        const { text, annotation } = augmentValue(row[index], this.kinds[index], this.data.classNames);
        longest = Math.max(longest, text.length + (annotation ? annotation.length + 1 : 0));
      }
      return Math.min(MAX_INITIAL_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, longest * 8 + 24));
    });
  }

  /**
   * The scrollable area's width, set explicitly for the same reason its height is: the rows
   * are absolutely positioned, so they do not stretch their container, and without this the
   * viewport would have nothing to scroll over horizontally.
   */
  private sizeSpacer(): void {
    const total = this.widths.reduce((sum, width) => sum + width, GUTTER_WIDTH);
    this.spacer.style.width = `${total}px`;
    this.spacer.style.height = `${this.data.rows.length * ROW_HEIGHT}px`;
  }

  private renderHeader(): void {
    this.header.replaceChildren();
    // Matches the gutter on every row, so the headers line up with their columns.
    const gutter = document.createElement("div");
    gutter.className = "results-head-cell results-gutter";
    this.header.appendChild(gutter);

    this.data.columns.forEach((column, index) => {
      const cell = document.createElement("div");
      cell.className = "results-head-cell";
      cell.style.width = `${this.widths[index]}px`;
      cell.title = `${column.name}${column.typeName ? ` : ${column.typeName}` : ""}`;
      cell.textContent = column.name;

      const grip = document.createElement("div");
      grip.className = "results-grip";
      grip.addEventListener("pointerdown", (event) => this.beginResize(event, index));
      cell.appendChild(grip);
      this.header.appendChild(cell);
    });
  }

  private beginResize(event: PointerEvent, index: number): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.widths[index];
    const move = (moveEvent: PointerEvent): void => {
      this.widths[index] = Math.max(MIN_COLUMN_WIDTH, startWidth + moveEvent.clientX - startX);
      this.sizeSpacer();
      this.renderHeader();
      this.renderRows();
    };
    const done = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
  }

  private renderRows(): void {
    const { rows } = this.data;
    const first = Math.max(0, Math.floor(this.viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(this.viewport.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const last = Math.min(rows.length, first + visible);

    this.body.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    this.body.replaceChildren();

    for (let index = first; index < last; index++)
      this.body.appendChild(this.renderRow(index, rows[index]));
  }

  private renderRow(index: number, row: unknown[]): HTMLElement {
    const element = document.createElement("div");
    element.className = "results-row";
    const isExpanded = this.expanded.has(index);
    if (isExpanded)
      element.classList.add("expanded");

    // The gutter is always present, whether or not this row has anything to expand: adding it
    // only to truncated rows would shift their cells and misalign the columns.
    const gutter = document.createElement("div");
    gutter.className = "results-cell results-gutter";
    element.appendChild(gutter);

    let hasExtraLong = false;
    this.data.columns.forEach((_column, columnIndex) => {
      const cell = document.createElement("div");
      cell.className = "results-cell";
      cell.style.width = `${this.widths[columnIndex]}px`;

      const value = augmentValue(row[columnIndex], this.kinds[columnIndex], this.data.classNames);
      cell.append(document.createTextNode(value.text));
      if (value.annotation) {
        const note = document.createElement("span");
        note.className = "results-annotation";
        note.textContent = ` ${value.annotation}`;
        cell.appendChild(note);
      }
      if (isTruncated(value, this.widths[columnIndex])) {
        // Marked for the hover, which reads the full value back from here.
        cell.dataset.truncated = "1";
        cell.dataset.value = value.text;
        if (value.annotation)
          cell.dataset.annotation = value.annotation;
      }
      // A chevron is only for values a hover cannot comfortably show.
      if (isExtraLong(value, this.widths[columnIndex]))
        hasExtraLong = true;
      element.appendChild(cell);
    });

    if (hasExtraLong) {
      const chevron = document.createElement("button");
      chevron.className = "results-chevron";
      chevron.textContent = isExpanded ? "▾" : "▸";
      chevron.title = isExpanded ? "Collapse row" : "Expand row";
      chevron.addEventListener("click", () => {
        if (isExpanded)
          this.expanded.delete(index);
        else
          this.expanded.add(index);
        this.hideHover();
        this.renderRows();
      });
      gutter.appendChild(chevron);
    }

    return element;
  }
}
