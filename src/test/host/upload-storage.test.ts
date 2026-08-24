import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AzureClientStorage, BlockBlobClientWrapperFactory } from "@itwin/object-storage-azure";
import type { ClientStorage } from "@itwin/object-storage-core";
import {
  DEFAULT_UPLOAD_BLOCK_SIZE_MB,
  DEFAULT_UPLOAD_CONCURRENCY,
  DEFAULT_UPLOAD_SINGLE_SHOT_MB,
  getUploadTuning,
  isTunableAzureUpload,
  ReportingUploadClientStorage,
} from "../../host/upload-storage";

const MIB = 1024 * 1024;

interface BlobRequest {
  comp: string;
  bytes: number;
}

/**
 * A stand-in for blob storage that records how the upload was split up. Azure's SDK only needs
 * a 201 with these headers to consider a staged block or a committed block list successful.
 */
class FakeBlobEndpoint {
  public readonly requests: BlobRequest[] = [];
  public maxInFlight = 0;
  private _inFlight = 0;
  private _server!: http.Server;

  public async start(): Promise<void> {
    this._server = http.createServer((req, res) => {
      this._inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this._inFlight);
      const comp = new URL(req.url!, "http://localhost").searchParams.get("comp") ?? "single-shot";
      let bytes = 0;
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; });
      req.on("end", () => {
        this._inFlight--;
        this.requests.push({ comp, bytes });
        res.writeHead(201, {
          "x-ms-request-id": "fake",
          "x-ms-version": "2025-01-05",
          "ETag": "\"0x1\"",
          "Last-Modified": new Date().toUTCString(),
          "Content-Length": "0",
        });
        res.end();
      });
    });
    await new Promise<void>((resolve) => this._server.listen(0, "127.0.0.1", resolve));
  }

  public get url(): string {
    const address = this._server.address();
    if (typeof address === "string" || address === null)
      throw new Error("fake blob endpoint is not listening on a port");
    return `http://127.0.0.1:${address.port}/container/baseline.bim?sv=fake&sig=fake`;
  }

  public reset(): void {
    this.requests.length = 0;
    this.maxInFlight = 0;
  }

  public countOf(comp: string): number {
    return this.requests.filter((r) => r.comp === comp).length;
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this._server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("getUploadTuning", () => {
  it("defaults to large blocks uploaded in parallel", () => {
    expect(getUploadTuning({})).toEqual({
      blockSize: DEFAULT_UPLOAD_BLOCK_SIZE_MB * MIB,
      concurrency: DEFAULT_UPLOAD_CONCURRENCY,
      maxSingleShotSize: DEFAULT_UPLOAD_SINGLE_SHOT_MB * MIB,
    });
  });

  it("defaults to more than the Azure SDK's own 4 MiB blocks and 5 way concurrency", () => {
    // The whole point of this storage: those defaults are what make a large seed file slow.
    const tuning = getUploadTuning({});
    expect(tuning.blockSize).toBeGreaterThan(4 * MIB);
    expect(tuning.concurrency).toBeGreaterThan(5);
    expect(tuning.maxSingleShotSize).toBeLessThan(256 * MIB);
  });

  it("takes overrides from the environment", () => {
    expect(getUploadTuning({
      IMOD_UPLOAD_BLOCK_SIZE_MB: "8",
      IMOD_UPLOAD_CONCURRENCY: "4",
      IMOD_UPLOAD_SINGLE_SHOT_MB: "2",
    })).toEqual({ blockSize: 8 * MIB, concurrency: 4, maxSingleShotSize: 2 * MIB });
  });

  it("ignores empty overrides", () => {
    expect(getUploadTuning({ IMOD_UPLOAD_CONCURRENCY: "  " }).concurrency)
      .toBe(DEFAULT_UPLOAD_CONCURRENCY);
  });

  it("rejects overrides that are not a positive number", () => {
    for (const bad of ["0", "-4", "abc"])
      expect(() => getUploadTuning({ IMOD_UPLOAD_CONCURRENCY: bad })).toThrow(/IMOD_UPLOAD_CONCURRENCY/);
    expect(() => getUploadTuning({ IMOD_UPLOAD_BLOCK_SIZE_MB: "0" })).toThrow(/IMOD_UPLOAD_BLOCK_SIZE_MB/);
  });
});

describe("isTunableAzureUpload", () => {
  const url = "https://example.blob.core.windows.net/c/b?sig=fake";

  it("recognizes a local file going to an Azure URL", () => {
    expect(isTunableAzureUpload({ url, storageType: "azure", data: "/tmp/seed.bim" })).toBe(true);
  });

  it("rejects other storage types", () => {
    expect(isTunableAzureUpload({ url, storageType: "google", data: "/tmp/seed.bim" })).toBe(false);
  });

  it("rejects data that is not a local file path", () => {
    expect(isTunableAzureUpload({ url, storageType: "azure", data: Buffer.alloc(8) })).toBe(false);
  });

  it("rejects transfer-config inputs, which carry no URL", () => {
    const input = {
      reference: { baseDirectory: "d", objectName: "b" },
      transferConfig: { baseUrl: "https://example.com", expiration: new Date(), storageType: "azure" },
      data: "/tmp/seed.bim",
    };
    expect(isTunableAzureUpload(input)).toBe(false);
  });
});

describe("ReportingUploadClientStorage", () => {
  const endpoint = new FakeBlobEndpoint();
  let seedFile: string;
  let tempDir: string;

  beforeAll(async () => {
    await endpoint.start();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "imod-upload-test-"));
    seedFile = path.join(tempDir, "seed.bim");
    fs.writeFileSync(seedFile, Buffer.alloc(8 * MIB, 7));
  });

  afterAll(async () => {
    await endpoint.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("splits an Azure upload into blocks of the configured size", async () => {
    endpoint.reset();
    const storage = new ReportingUploadClientStorage(
      undefined,
      { blockSize: 2 * MIB, concurrency: 4, maxSingleShotSize: MIB },
    );

    await storage.upload({ url: endpoint.url, storageType: "azure", data: seedFile });

    expect(endpoint.countOf("block")).toBe(4);
    expect(endpoint.countOf("blocklist")).toBe(1);
    expect(endpoint.requests.filter((r) => r.comp === "block").map((r) => r.bytes))
      .toEqual([2 * MIB, 2 * MIB, 2 * MIB, 2 * MIB]);
    expect(endpoint.countOf("single-shot")).toBe(0);
  });

  it("uploads in parallel", async () => {
    endpoint.reset();
    const storage = new ReportingUploadClientStorage(
      undefined,
      { blockSize: MIB, concurrency: 4, maxSingleShotSize: MIB },
    );

    await storage.upload({ url: endpoint.url, storageType: "azure", data: seedFile });

    expect(endpoint.maxInFlight).toBeGreaterThan(1);
    expect(endpoint.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("improves on the stock storage, which sends the whole file as one request", async () => {
    endpoint.reset();
    const stock = new AzureClientStorage(new BlockBlobClientWrapperFactory());

    await stock.upload({ url: endpoint.url, storageType: "azure", data: seedFile });

    // 8 MiB is under the Azure SDK's 256 MiB maxSingleShotSize default, so it goes up whole.
    expect(endpoint.countOf("single-shot")).toBe(1);
    expect(endpoint.countOf("block")).toBe(0);
    expect(endpoint.maxInFlight).toBe(1);
  });

  it("passes non-Azure uploads through untouched", async () => {
    const inner = { upload: vi.fn().mockResolvedValue(undefined) } as unknown as ClientStorage;
    const storage = new ReportingUploadClientStorage(inner);
    const input = { url: endpoint.url, storageType: "google", data: seedFile };

    await storage.upload(input);

    expect(inner.upload).toHaveBeenCalledWith(input);
  });

  it("delegates downloads and multipart uploads", async () => {
    const inner = {
      download: vi.fn().mockResolvedValue("/tmp/out.bim"),
      uploadInMultipleParts: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClientStorage;
    const storage = new ReportingUploadClientStorage(inner);

    await storage.download({
      url: endpoint.url,
      storageType: "azure",
      transferType: "local",
      localPath: "/tmp/out.bim",
    });
    await storage.uploadInMultipleParts({
      data: seedFile,
      reference: { baseDirectory: "d", objectName: "b" },
      transferConfig: { baseUrl: "https://example.com", expiration: new Date(), storageType: "azure" },
    });

    expect(inner.download).toHaveBeenCalledOnce();
    expect(inner.uploadInMultipleParts).toHaveBeenCalledOnce();
  });
});
