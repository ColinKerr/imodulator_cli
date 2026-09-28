import type { CommandModule } from "yargs";
import { getCacheDb } from "../../../cache/cache-db";
import { formatTable, type TableData } from "../../../format/table";

export interface DbTableDump extends TableData {
  name: string;
}

/**
 * Tables this dump leaves out.
 *
 * `changesets` runs to tens of thousands of rows for one iModel -- 43,890 for a real one --
 * which would bury every other table. `imod cache list changesets` shows it, per iModel and by
 * range.
 */
const OMITTED_TABLES = ["changesets"];

export function runListDb(): DbTableDump[] {
  const db = getCacheDb();
  const tables = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[])
    .filter(({ name }) => !OMITTED_TABLES.includes(name));

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

export const cacheListDbCommand: CommandModule = {
  command: "db",
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
