import * as fs from "node:fs";
import type { CommandModule } from "yargs";
import {
  iterateChangesetGaps, iterateRecordedChangesetFiles, summarizeChangesets, type ChangesetRange,
} from "../../../cache/changesets";

/** Bytes of lines gathered before each write: one write per line is a syscall per changeset. */
const WRITE_CHUNK_BYTES = 1024 * 1024;

/** Gap runs named in the error before the rest are only counted. */
const GAPS_SHOWN = 20;

export interface ListChangesetFilesArgs extends ChangesetRange {
  imodelId: string;
  /** The file to write, one `<index> <path>` line per changeset. */
  outFile: string;
}

export interface ListChangesetFilesResult {
  outFile: string;
  /** Lines written. */
  written: number;
  /** Changesets whose recorded file is not on disk, and so were left out. */
  missingOnDisk: number[];
  minIndex?: number;
  maxIndex?: number;
}

/** `3, 7..12, 40`, naming the first few runs and counting the rest. */
function describeGaps(gaps: { first: number; last: number }[], total: number): string {
  const shown = gaps.map((gap) => (gap.first === gap.last ? `${gap.first}` : `${gap.first}..${gap.last}`));
  const more = total - gaps.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more run(s)` : shown.join(", ");
}

/**
 * Write every changeset file in a range to a list, lowest index first, one `<index> <path>` per line.
 *
 * The range must be complete: a changeset with no file recorded, or an index with no metadata, is
 * an error naming the gaps, and nothing is written. A file recorded but no longer on disk is left
 * out and reported, since `imod cache repair-changesets` is what brings the db back in line.
 *
 * Written to a temporary name and renamed into place, so an interrupted run never leaves a list
 * that looks complete. Paths are written unescaped; cache paths are assumed to have no spaces.
 */
export function runListChangesetFiles(args: ListChangesetFilesArgs): ListChangesetFilesResult {
  const range: ChangesetRange = { start: args.start, end: args.end };
  const summary = summarizeChangesets(args.imodelId, range);
  if (summary.count === 0)
    throw new Error(
      `No changesets cached for iModel ${args.imodelId} in that range. ` +
      `Fetch them with: imod hub changeset download metadata --imodel-id ${args.imodelId}`,
    );

  const gaps: { first: number; last: number }[] = [];
  let gapCount = 0;
  for (const gap of iterateChangesetGaps(args.imodelId, range)) {
    if (gaps.length < GAPS_SHOWN)
      gaps.push(gap);
    gapCount++;
  }
  if (gapCount > 0)
    throw new Error(
      `Changesets in that range have no file: ${describeGaps(gaps, gapCount)}. ` +
      `Download them with: imod hub changeset download files --imodel-id ${args.imodelId} --start <n> --end <n>`,
    );

  const result: ListChangesetFilesResult = { outFile: args.outFile, written: 0, missingOnDisk: [] };
  const tempFile = `${args.outFile}.tmp`;
  const fd = fs.openSync(tempFile, "w");
  try {
    let chunk = "";
    for (const changeset of iterateRecordedChangesetFiles(args.imodelId, range)) {
      if (!fs.existsSync(changeset.filePath!)) {
        result.missingOnDisk.push(changeset.index);
        continue;
      }
      chunk += `${changeset.index} ${changeset.filePath}\n`;
      result.written++;
      result.minIndex ??= changeset.index;
      result.maxIndex = changeset.index;
      if (chunk.length >= WRITE_CHUNK_BYTES) {
        fs.writeSync(fd, chunk);
        chunk = "";
      }
    }
    fs.writeSync(fd, chunk);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tempFile, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tempFile, args.outFile);

  return result;
}

export const cacheListChangesetFilesCommand: CommandModule<unknown, ListChangesetFilesArgs> = {
  command: "changeset-files",
  describe: "Write the cached changeset files for an iModel to a file, one '<index> <path>' per line",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "The iModel id (GUID)" })
      .option("out-file", { type: "string", demandOption: true, describe: "The file to write the list to" })
      .option("start", { type: "number", describe: "First changeset index to list, inclusive" })
      .option("end", { type: "number", describe: "Last changeset index to list, inclusive" }) as never,
  handler: (argv) => {
    const result = runListChangesetFiles({
      imodelId: argv.imodelId,
      outFile: argv.outFile,
      start: argv.start,
      end: argv.end,
    });

    console.log(
      result.written === 0
        ? `Wrote no changeset files to ${result.outFile}.`
        : `Wrote ${result.written} changeset file(s), index ${result.minIndex}..${result.maxIndex}, to ${result.outFile}.`,
    );
    const missing = result.missingOnDisk;
    if (missing.length > 0)
      console.warn(
        `${missing.length} recorded changeset file(s) are not on disk and were left out, ` +
        `e.g. index ${missing[0]}. Run: imod cache repair-changesets --imodel-id ${argv.imodelId}`,
      );
  },
};
