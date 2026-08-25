import { join } from "node:path";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { BriefcaseManager } from "@itwin/core-backend";
// HubMock is shipped but marked @internal, so it is imported from its module path.
import { HubMock } from "@itwin/core-backend/lib/cjs/internal/HubMock";
import { Logger, LogLevel } from "@itwin/core-bentley";
import type { AuthorizationClient } from "@itwin/core-common";
import { startIModelHost, shutdownIModelHost } from "../host/imodel-host";

const TEST_TOKEN = "test-token";

/**
 * Refuse to start a host that would open the developer's real cache.
 *
 * `IModelHost.startup` takes an exclusive lock on the workspace profile in the cache
 * directory, so a test running against `~/.imod/cache` locks out every other process using
 * it -- another test run, or a live `imod serve backend`. Failing here names the file that
 * skipped its isolation instead of surfacing as a lock error somewhere else.
 */
function assertIsolated(): void {
  const cacheDir = process.env.IMOD_CACHE_DIR;
  if (!cacheDir)
    throw new Error("IMOD_CACHE_DIR is not set: src/test/temp-workspace.ts should have set it.");
  if (!realpathSync(cacheDir).startsWith(realpathSync(tmpdir())))
    throw new Error(`the test cache must be a temporary directory, but IMOD_CACHE_DIR is ${cacheDir}`);
}

const mockAuthClient: AuthorizationClient = {
  getAccessToken: async () => TEST_TOKEN,
};

export interface TestBriefcase {
  fileName: string;
  iModelId: string;
  iTwinId: string;
  briefcaseId: number;
}

export class HubMockFixture {
  private outputDir = "";
  private started = false;

  async startup(mockName: string): Promise<void> {
    assertIsolated();
    await startIModelHost(mockAuthClient);

    this.outputDir = mkdtempSync(join(tmpdir(), `imod-${mockName}-`));
    HubMock.startup(mockName, this.outputDir);
    this.started = true;
  }

  async shutdown(): Promise<void> {
    if (this.started) {
      HubMock.shutdown();
      this.started = false;
    }
    await shutdownIModelHost();
    if (this.outputDir)
      rmSync(this.outputDir, { recursive: true, force: true });
  }

  /** Create a new empty iModel and download a writable, lock-free briefcase of it. */
  async createBriefcase(iModelName: string): Promise<TestBriefcase> {
    const iTwinId = HubMock.iTwinId;
    const iModelId = await HubMock.createNewIModel({
      accessToken: TEST_TOKEN,
      iTwinId,
      iModelName,
      noLocks: true,
    });
    const props = await BriefcaseManager.downloadBriefcase({
      accessToken: TEST_TOKEN,
      iTwinId,
      iModelId,
    });
    return { fileName: props.fileName, iModelId, iTwinId, briefcaseId: props.briefcaseId };
  }
}
