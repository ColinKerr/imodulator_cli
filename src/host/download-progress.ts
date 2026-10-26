import { ProgressStatus, type ProgressFunction } from "@itwin/core-backend";

/** Where progress is written. `process.stdout` in practice; a stand-in in tests. */
export interface ProgressOutput {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
}

/**
 * Build a {@link ProgressFunction} that reports download progress to the console. Output is
 * throttled (to whole-percent changes, or each MiB when the total size is unknown) so the
 * frequent native callbacks do not flood the console. Never aborts the download.
 *
 * On a terminal the report rewrites a single line in place, and that line is ended once the
 * download reaches 100%. When output is not a terminal -- piped, or captured to a log -- each
 * report is its own line instead, since carriage returns there would only garble the log.
 */
export function createDownloadProgress(label: string, out: ProgressOutput = process.stdout): ProgressFunction {
  let lastPercent = -1;
  let lastMib = -1;

  const report = (text: string, finished: boolean) => {
    if (!out.isTTY) {
      console.log(text);
      return;
    }
    // A line wider than the terminal wraps, and `\r` only returns to the start of the last
    // row, so the report is cut to fit rather than left to smear across the screen.
    const width = out.columns ?? 0;
    const fitted = width > 1 && text.length >= width ? text.slice(0, width - 1) : text;
    out.write(`\r${fitted}\x1b[K`);
    if (finished)
      out.write("\n");
  };

  return (loaded: number, total: number): ProgressStatus => {
    if (total > 0) {
      const percent = Math.floor((loaded / total) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        report(`${label}: ${percent}% (${formatBytes(loaded)} / ${formatBytes(total)})`, percent >= 100);
      }
    } else {
      const mib = Math.floor(loaded / (1024 * 1024));
      if (mib !== lastMib) {
        lastMib = mib;
        report(`${label}: ${formatBytes(loaded)} downloaded`, false);
      }
    }
    return ProgressStatus.Continue;
  };
}

/** Human-readable byte count (B, KiB, MiB, ...). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
