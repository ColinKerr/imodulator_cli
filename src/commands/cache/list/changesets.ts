import type { CommandModule } from "yargs";
import { formatTable } from "../../../format/table";
import {
  iterateCachedChangesets, listCachedChangesets, summarizeChangesets,
  type CachedChangeset, type ChangesetRange,
} from "../../../cache/changesets";
import { formatBytes } from "../../hub/changeset/download-metadata";

/**
 * Rows printed unless `--limit` says otherwise.
 *
 * An iModel can hold hundreds of thousands of changesets. Listing half a million measured at
 * 954 MiB resident and a 48.6 MiB, 500,004 line table, built entirely before a byte of it is
 * printed -- so the default is a window, and the footer says what it is a window onto.
 */
const DEFAULT_LIMIT = 200;

export interface ListChangesetsArgs extends ChangesetRange {
  imodelId: string;
  /** Show only changesets whose file has been downloaded. */
  downloadedOnly?: boolean;
  /** How many rows to print. 0 means all of them. */
  limit?: number;
}

export interface ListChangesetsResult {
  /** The rows to print, which is a window onto the range unless `limit` is 0. */
  changesets: CachedChangeset[];
  /** True when the range holds more changesets than are being shown. */
  truncated: boolean;
  count: number;
  withFile: number;
  totalBytes: number;
  missingBytes: number;
}

export function runListChangesets(args: ListChangesetsArgs): ListChangesetsResult {
  const range: ChangesetRange = { start: args.start, end: args.end };
  const summary = summarizeChangesets(args.imodelId, range);
  const limit = args.limit ?? DEFAULT_LIMIT;

  // The limit goes to SQLite rather than being applied afterwards: slicing an array of half a
  // million rows means having built it first, which is the thing being avoided.
  const changesets = args.downloadedOnly
    ? downloadedOnly(args.imodelId, range, limit)
    : listCachedChangesets(args.imodelId, range, limit === 0 ? {} : { limit });

  return {
    changesets,
    truncated: limit !== 0 && summary.count > changesets.length,
    count: summary.count,
    withFile: summary.withFile,
    totalBytes: summary.totalBytes,
    missingBytes: summary.missingBytes,
  };
}

/** Downloaded changesets only, stopping once the limit is filled rather than filtering a list. */
function downloadedOnly(imodelId: string, range: ChangesetRange, limit: number): CachedChangeset[] {
  const found: CachedChangeset[] = [];
  for (const changeset of iterateCachedChangesets(imodelId, range)) {
    if (changeset.filePath === undefined)
      continue;
    found.push(changeset);
    if (limit !== 0 && found.length >= limit)
      break;
  }
  return found;
}

/** Enough of the description to recognise a changeset, without wrapping the table. */
function shorten(text: string | undefined, width = 44): string {
  if (!text)
    return "";
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

export const cacheListChangesetsCommand: CommandModule<unknown, ListChangesetsArgs> = {
  command: "changesets",
  describe: "List the cached changesets for an iModel",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("start", { type: "number", describe: "First changeset index to list, inclusive" })
      .option("end", { type: "number", describe: "Last changeset index to list, inclusive" })
      .option("limit", {
        type: "number",
        default: DEFAULT_LIMIT,
        describe: "How many rows to print. 0 prints every changeset in the range",
      })
      .option("downloaded-only", {
        type: "boolean",
        default: false,
        describe: "List only changesets whose file has been downloaded",
      }) as never,
  handler: (argv) => {
    const result = runListChangesets({
      imodelId: argv.imodelId,
      start: argv.start,
      end: argv.end,
      downloadedOnly: argv.downloadedOnly,
      limit: argv.limit,
    });

    if (result.count === 0) {
      console.log(
        `No changesets cached for iModel ${argv.imodelId}. Fetch them with: imod hub changeset download metadata --imodel-id ${argv.imodelId}`,
      );
      return;
    }

    console.log(
      formatTable({
        columns: ["index", "id", "file", "size", "pushed", "description"],
        rows: result.changesets.map((changeset) => [
          changeset.index,
          changeset.id.slice(0, 12),
          changeset.filePath ? "yes" : "",
          formatBytes(changeset.fileSize),
          changeset.pushDateTime?.slice(0, 10) ?? "",
          shorten(changeset.description),
        ]),
      }),
    );

    // The counts describe the whole range, not just the rows printed, so --downloaded-only and
    // --limit still say how much of the range there is and how much of it is missing.
    console.log(
      `\n${result.count} changeset(s), ${result.withFile} downloaded. ` +
      `${formatBytes(result.totalBytes)} in total, ${formatBytes(result.missingBytes)} not yet fetched.`,
    );
    if (result.truncated)
      console.log(
        `Showing ${result.changesets.length} of ${result.count}. Narrow it with --start/--end, or pass --limit 0 for all of them.`,
      );
  },
};
