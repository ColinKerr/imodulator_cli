import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BriefcaseDb } from "@itwin/core-backend";
import type { QueryStats } from "@itwin/core-common";
import { startIModelHost } from "../../host/imodel-host";
import { _nativeDb } from "@itwin/core-backend/lib/cjs/internal/Symbols.js";



export interface QueryArgs {
  imodelPath: string;
  queryPath: string;
  resultsPath: string;
}

const NEEDS_QUOTING = /[",\r\n]/;

export async function runQuery(args: QueryArgs): Promise<QueryStats> {
  if (!fs.existsSync(args.imodelPath))
    throw new Error(`iModel file not found: ${args.imodelPath}`);
  if (!fs.existsSync(args.queryPath))
    throw new Error(`Query file not found: ${args.queryPath}`);

  const ecsql = fs.readFileSync(args.queryPath, "utf8").trim();
  if (ecsql.length === 0)
    throw new Error(`Query file is empty: ${args.queryPath}`);

  await startIModelHost();
  const db = await BriefcaseDb.open({ fileName: args.imodelPath, readonly: true });
  const out = fs.createWriteStream(args.resultsPath, { encoding: "utf8" });
  db[_nativeDb].startProfiler();

  try {
    const reader = db.createQueryReader(ecsql);
    const meta = await reader.getMetaData();
    const header = meta.map((m) => m.name);
    out.write(`${header.map(toCsvCell).join(",")}\n`);

    for await (const row of reader) {
      const values = row.toArray();
      out.write(`${values.map(toCsvCell).join(",")}\n`);
    }

    let { fileName } = db[_nativeDb].stopProfiler();

    console.log(`Query profiler output in ${fileName}`);

    return reader.stats;
  } finally {
    db.close();
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

function toCsvCell(value: unknown): string {
  if (value === null || value === undefined)
    return "";
  let text: string;
  if (typeof value === "string")
    text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    text = String(value);
  else
    text = JSON.stringify(value);
  if (NEEDS_QUOTING.test(text))
    return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function formatQueryStats(stats: QueryStats): string {
  return [
    "Query statistics:",
    `  Rows returned:      ${stats.backendRowsReturned}`,
    `  Backend CPU time:   ${(stats.backendCpuTime / 1000).toFixed(2)} ms`,
    `  Backend total time: ${stats.backendTotalTime} ms`,
    `  Total time:         ${stats.totalTime} ms`,
    `  Memory used:        ${stats.backendMemUsed} bytes`,
    `  Retries:            ${stats.retryCount}`,
  ].join("\n");
}

export const queryCommand: CommandModule<unknown, QueryArgs> = {
  command: "query",
  describe: "Execute an ECSql query against a local iModel and write results as CSV",
  builder: (y) =>
    y
      .option("imodel-path", { type: "string", demandOption: true, describe: "Path to the local iModel file" })
      .option("query-path", { type: "string", demandOption: true, describe: "Path to a file containing a single ECSql query" })
      .option("results-path", { type: "string", demandOption: true, describe: "Path to write CSV results (overwrites existing files)" }) as never,
  handler: async (argv) => {
    const stats = await runQuery({
      imodelPath: argv.imodelPath,
      queryPath: argv.queryPath,
      resultsPath: argv.resultsPath,
    });
    console.log(`Wrote results to ${argv.resultsPath}`);
    console.log(formatQueryStats(stats));
  },
};
