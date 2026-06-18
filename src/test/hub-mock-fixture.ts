import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { BriefcaseManager } from "@itwin/core-backend";
// HubMock is shipped but marked @internal, so it is imported from its module path.
import { HubMock } from "@itwin/core-backend/lib/cjs/internal/HubMock";
import { Logger, LogLevel } from "@itwin/core-bentley";
import { startIModelHost, shutdownIModelHost } from "../host/imodel-host";

const TEST_TOKEN = "test-token";

export interface TestBriefcase {
  fileName: string;
  iModelId: string;
  iTwinId: string;
  briefcaseId: number;
}

/**
 * Lifecycle helper for command tests that need a writable iModel.
 *
 * It starts the shared IModelHost, redirects all hub access to a process-local
 * {@link HubMock} (no authentication or network), and can mint writable
 * briefcases on demand. Call {@link startup} in `beforeAll` and {@link shutdown}
 * in `afterAll`.
 */
export class HubMockFixture {
  private outputDir = "";
  private started = false;

  async startup(mockName: string): Promise<void> {
    // startIModelHost constructs an auth client that requires a client id, even
    // though HubMock never uses it. Provide a dummy one if the env is unset.
    if (!process.env.IMOD_CLIENT_ID)
      process.env.IMOD_CLIENT_ID = "test-client-id";

    await startIModelHost();
    // startIModelHost enables trace logging; quiet it so test output stays readable.
    Logger.setLevelDefault(LogLevel.Error);
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
