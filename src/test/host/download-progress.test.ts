import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressStatus } from "@itwin/core-backend";
import { createDownloadProgress, formatBytes } from "../../host/download-progress";

describe("download progress", () => {
  describe("formatBytes", () => {
    it("formats byte counts in the largest fitting unit", () => {
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(1024)).toBe("1.0 KiB");
      expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
      expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GiB");
    });
  });

  describe("createDownloadProgress", () => {
    let log: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      log = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      log.mockRestore();
    });

    it("continues the download and logs only on whole-percent changes", () => {
      const progress = createDownloadProgress("dl");

      expect(progress(0, 1000)).toBe(ProgressStatus.Continue);
      expect(progress(5, 1000)).toBe(ProgressStatus.Continue); // still 0%
      expect(progress(10, 1000)).toBe(ProgressStatus.Continue); // 1%
      expect(progress(1000, 1000)).toBe(ProgressStatus.Continue); // 100%

      // 0%, 1%, 100% -> three log lines (the 0.5% step is throttled out).
      expect(log).toHaveBeenCalledTimes(3);
      expect(log.mock.calls[0][0]).toContain("dl: 0%");
      expect(log.mock.calls[2][0]).toContain("dl: 100%");
    });

    it("logs per-MiB when the total size is unknown", () => {
      const progress = createDownloadProgress("dl");
      progress(0, 0);
      progress(512 * 1024, 0); // same MiB bucket -> throttled
      progress(1024 * 1024, 0); // next MiB

      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[1][0]).toContain("1.0 MiB downloaded");
    });
  });
});
