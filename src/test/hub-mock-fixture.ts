import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { BriefcaseManager } from "@itwin/core-backend";
// HubMock is shipped but marked @internal, so it is imported from its module path.
import { HubMock } from "@itwin/core-backend/lib/cjs/internal/HubMock";
import { Logger, LogLevel } from "@itwin/core-bentley";
import type { AuthorizationClient } from "@itwin/core-common";
import { startIModelHost, shutdownIModelHost } from "../host/imodel-host";

const TEST_TOKEN = "test-token";

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
