import type { CommandModule } from "yargs";
import { getCacheDb } from "../../cache/cache-db";

export interface DbTableDump {
  name: string;
  columns: string[];
  rows: unknown[][];
}

export function runListDb(): DbTableDump[] {
  const db = getCacheDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];

  return tables.map(({ name }) => {
    const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
    const columns = db
      .prepare(`PRAGMA table_info("${name}")`)
      .all()
      .map((c) => (c as { name: string }).name);
    return {
      name,
      columns,
      rows: rows.map((r) => columns.map((c) => r[c])),
    };
  });
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined)
    return "NULL";
  if (typeof v === "string")
    return v;
  if (v instanceof Buffer)
    return `<blob ${v.length}B>`;
  return String(v);
}

function formatTable(table: DbTableDump): string {
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

  const lines = [
    sep,
    renderRow(table.columns),
    sep,
    ...cellRows.map(renderRow),
    sep,
  ];
  return lines.join("\n");
}

export const cacheListDbCommand: CommandModule = {
  command: "list-db",
  describe: "List contents of the cache db in formatted tables",
  builder: (y) => y,
  handler: () => {
    const dump = runListDb();
    if (dump.length === 0) {
      console.log("(cache db is empty)");
      return;
    }
    for (const table of dump) {
      console.log(`\n${table.name} (${table.rows.length} row${table.rows.length === 1 ? "" : "s"})`);
      console.log(formatTable(table));
    }
  },
};
