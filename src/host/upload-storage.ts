import * as fs from "node:fs";
import { Readable } from "node:stream";
import { BlockBlobClient } from "@azure/storage-blob";
import { AzureClientStorage, BlockBlobClientWrapperFactory } from "@itwin/object-storage-azure";
import {
  ClientStorage,
  ConfigDownloadInput,
  ConfigUploadInput,
  isUrlTransferInput,
  StrategyClientStorage,
  UploadInMultiplePartsInput,
  UrlDownloadInput,
  UrlUploadInput,
} from "@itwin/object-storage-core";
import { GoogleClientStorage, StorageWrapperFactory } from "@itwin/object-storage-google";

/**
 * Upload tuning. The stock client leaves all three unset, which lands on the Azure SDK's
 * defaults: one single PUT for anything up to 256 MiB, otherwise 4 MiB blocks 5 at a time.
 * That is what makes uploading a large seed file slow.
 */
export const DEFAULT_UPLOAD_BLOCK_SIZE_MB = 32;
export const DEFAULT_UPLOAD_CONCURRENCY = 16;
export const DEFAULT_UPLOAD_SINGLE_SHOT_MB = 8;

export interface UploadTuning {
  blockSize: number;
  concurrency: number;
  maxSingleShotSize: number;
}

/**
 * Read tuning from the environment so a slow or unusually fast link can be adjusted without
 * a rebuild. The defaults are a starting point, not a measured optimum.
 */
export function getUploadTuning(env: NodeJS.ProcessEnv = process.env): UploadTuning {
  const mib = (name: string, fallback: number) =>
    readPositiveNumber(env[name], name, fallback) * 1024 * 1024;
  return {
    blockSize: mib("IMOD_UPLOAD_BLOCK_SIZE_MB", DEFAULT_UPLOAD_BLOCK_SIZE_MB),
    concurrency: readPositiveNumber(
      env.IMOD_UPLOAD_CONCURRENCY,
      "IMOD_UPLOAD_CONCURRENCY",
      DEFAULT_UPLOAD_CONCURRENCY,
    ),
    maxSingleShotSize: mib("IMOD_UPLOAD_SINGLE_SHOT_MB", DEFAULT_UPLOAD_SINGLE_SHOT_MB),
  };
}

function readPositiveNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0)
    return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  return value;
}

/**
 * The storage the iModels client would have built for itself.
 *
 * Mirrors `createDefaultClientStorage` in @itwin/imodels-access-backend, which is not exported
 * from that package's entry point. Downloads and non-Azure uploads are delegated to it unchanged.
 */
export function createBaseClientStorage(): ClientStorage {
  return new StrategyClientStorage([
    { instanceName: "azure", instance: new AzureClientStorage(new BlockBlobClientWrapperFactory()) },
    { instanceName: "google", instance: new GoogleClientStorage(new StorageWrapperFactory()) },
  ]);
}

/** Whether an upload is a local file going to an Azure SAS URL, the only case this storage changes. */
export function isTunableAzureUpload(
  input: UrlUploadInput | ConfigUploadInput,
): input is UrlUploadInput & { data: string } {
  return isUrlTransferInput(input) && input.storageType === "azure" && typeof input.data === "string";
}

const MIB = 1024 * 1024;
const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

/**
 * Uploads a local file to Azure in large blocks, in parallel.
 *
 * `ClientStorage.upload` reaches `BlockBlobClient.uploadFile` with no block size and no
 * concurrency, and `uploadInMultipleParts` cannot lower `maxSingleShotSize`, so this goes
 * to `BlockBlobClient` directly. Everything else is passed through to `_inner`.
 */
export class ReportingUploadClientStorage extends ClientStorage {
  constructor(
    private readonly _inner: ClientStorage = createBaseClientStorage(),
    private readonly _tuning: UploadTuning = getUploadTuning(),
  ) {
    super();
  }

  public download(input: (UrlDownloadInput | ConfigDownloadInput) & { transferType: "buffer" }): Promise<Buffer>;
  public download(input: (UrlDownloadInput | ConfigDownloadInput) & { transferType: "stream" }): Promise<Readable>;
  public download(input: (UrlDownloadInput | ConfigDownloadInput) & { transferType: "local"; localPath: string }): Promise<string>;
  public download(input: UrlDownloadInput | ConfigDownloadInput): Promise<Buffer | Readable | string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this._inner.download as (i: any) => Promise<Buffer | Readable | string>)(input);
  }

  public async upload(input: UrlUploadInput | ConfigUploadInput): Promise<void> {
    if (!isTunableAzureUpload(input)) {
      const storageType = "storageType" in input ? input.storageType : input.transferConfig?.storageType;
      console.log(`Upload is not a tunable Azure transfer (storageType '${storageType}'); using the stock client.`);
      return this._inner.upload(input);
    }

    const size = fs.statSync(input.data).size;
    const blocks = Math.ceil(size / this._tuning.blockSize);
    console.log(
      `Uploading ${mib(size)} to ${new URL(input.url).host} in ${blocks} block(s) of ` +
      `${mib(this._tuning.blockSize)}, ${this._tuning.concurrency} at a time.`,
    );

    const startedAt = Date.now();

    await new BlockBlobClient(input.url).uploadFile(input.data, {
      metadata: input.metadata,
      blockSize: this._tuning.blockSize,
      concurrency: this._tuning.concurrency,
      maxSingleShotSize: this._tuning.maxSingleShotSize,
      onProgress: ({ loadedBytes }) => {
        process.stdout.write(`\r${mib(loadedBytes)} of ${mib(size)} uploaded ...`);
      },
    });

    const seconds = (Date.now() - startedAt) / 1000;
    console.log(`Upload finished in ${seconds.toFixed(1)}s, averaging ${(size / MIB / seconds).toFixed(1)} MiB/s.`);
  }

  public uploadInMultipleParts(input: UploadInMultiplePartsInput): Promise<void> {
    return this._inner.uploadInMultipleParts(input);
  }
}
