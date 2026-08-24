import { augmentValue, columnKind, type ColumnInfo, type ColumnKind } from "./query-shape";

/** Rows rendered outside the viewport, so scrolling does not flash empty space. */
const OVERSCAN = 10;
const ROW_HEIGHT = 24;
const MIN_COLUMN_WIDTH = 48;
const MAX_INITIAL_COLUMN_WIDTH = 420;

export interface TableData {
  columns: ColumnInfo[];
  rows: unknown[][];
  /** Class id to `Schema.Class`, used to annotate class id columns. */
  classNames: ReadonlyMap<string, string>;
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
  private data: TableData = { columns: [], rows: [], classNames: new Map() };
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
    this.spacer.appendChild(this.body);
    this.viewport.appendChild(this.spacer);
    this.root.append(this.header, this.viewport);
    this.viewport.addEventListener("scroll", () => {
      // The header sits outside the scrolling viewport so it stays visible, which means its
      // horizontal position has to be driven from here or the columns drift out of line.
      this.header.scrollLeft = this.viewport.scrollLeft;
      this.renderRows();
    });
  }

  public get rowCount(): number {
    return this.data.rows.length;
  }

  public setData(data: TableData): void {
    this.data = data;
    this.kinds = data.columns.map(columnKind);
    this.widths = this.measureColumns();
    this.expanded.clear();
    this.viewport.scrollTop = 0;
    this.renderHeader();
    this.spacer.style.height = `${data.rows.length * ROW_HEIGHT}px`;
    this.sizeSpacer();
    this.renderRows();
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
    const total = this.widths.reduce((sum, width) => sum + width, 0);
    this.spacer.style.width = `${total}px`;
  }

  private renderHeader(): void {
    this.header.replaceChildren();
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

    let truncated = false;
    this.data.columns.forEach((_column, columnIndex) => {
      const cell = document.createElement("div");
      cell.className = "results-cell";
      cell.style.width = `${this.widths[columnIndex]}px`;

      const { text, annotation } = augmentValue(row[columnIndex], this.kinds[columnIndex], this.data.classNames);
      cell.append(document.createTextNode(text));
      if (annotation) {
        const note = document.createElement("span");
        note.className = "results-annotation";
        note.textContent = ` ${annotation}`;
        cell.appendChild(note);
      }
      // Roughly 8px per character: enough to know the value cannot fit its column.
      if ((text.length + (annotation?.length ?? 0)) * 8 + 24 > this.widths[columnIndex])
        truncated = true;
      element.appendChild(cell);
    });

    if (truncated) {
      const chevron = document.createElement("button");
      chevron.className = "results-chevron";
      chevron.textContent = isExpanded ? "▾" : "▸";
      chevron.title = isExpanded ? "Collapse row" : "Expand row";
      chevron.addEventListener("click", () => {
        if (isExpanded)
          this.expanded.delete(index);
        else
          this.expanded.add(index);
        this.renderRows();
      });
      element.insertBefore(chevron, element.firstChild);
    }

    return element;
  }
}
