import { ProgressStatus, type ProgressFunction } from "@itwin/core-backend";

/**
 * Build a {@link ProgressFunction} that logs download progress to the console. Output is
 * throttled (to whole-percent changes, or each MiB when the total size is unknown) so the
 * frequent native callbacks do not flood the console. Never aborts the download.
 */
export function createDownloadProgress(label: string): ProgressFunction {
  let lastPercent = -1;
  let lastMib = -1;
  return (loaded: number, total: number): ProgressStatus => {
    if (total > 0) {
      const percent = Math.floor((loaded / total) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        console.log(`${label}: ${percent}% (${formatBytes(loaded)} / ${formatBytes(total)})`);
      }
    } else {
      const mib = Math.floor(loaded / (1024 * 1024));
      if (mib !== lastMib) {
        lastMib = mib;
        console.log(`${label}: ${formatBytes(loaded)} downloaded`);
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
