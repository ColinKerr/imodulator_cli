/** Plain-text table rendering shared by the commands that print tabular output. */

export interface TableData {
  columns: string[];
  rows: unknown[][];
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined)
    return "NULL";
  if (typeof value === "string")
    return value;
  if (value instanceof Buffer)
    return `<blob ${value.length}B>`;
  return String(value);
}

export function formatTable(table: TableData): string {
  const widths = table.columns.map((c) => c.length);
  const cellRows = table.rows.map((row) => {
    const cells = row.map(formatCell);
    cells.forEach((cell, i) => {
      if (cell.length > widths[i])
        widths[i] = cell.length;
    });
    return cells;
  });

  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const renderRow = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;

  return [
    sep,
    renderRow(table.columns),
    sep,
    ...cellRows.map(renderRow),
    sep,
  ].join("\n");
}
