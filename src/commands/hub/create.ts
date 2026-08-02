import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { BaselineFileState } from "@itwin/imodels-client-authoring";
import {
  Constants,
  IModelsErrorCode,
  IModelsErrorImpl,
  UtilityFunctions,
} from "@itwin/imodels-client-management";
import { startIModelHost } from "../../host/imodel-host";
import { getHubAccess, getHubAuthorization } from "../../host/hub-access";

/**
 * How long to wait for the hub to initialize an uploaded baseline file. The client's own
 * default is 5 minutes, which is not enough for a multi-gigabyte seed file.
 */
export const DEFAULT_INIT_TIMEOUT_MINUTES = 30;

export interface CreateIModelArgs {
  itwinId: string;
  name: string;
  seedFile?: string;
  description?: string;
  /** Minutes to wait for baseline initialization. Defaults to `DEFAULT_INIT_TIMEOUT_MINUTES`. */
  initTimeoutMinutes?: number;
  /** Wait on an iModel whose creation already uploaded its baseline, instead of creating one. */
  resume?: boolean;
}

/**
 * Raise the wait for baseline file initialization.
 *
 * `BackendIModelsAccess.createNewIModel` never forwards `timeOutInMs` to the client's
 * `createFromBaseline`, so this shared constant is the only reachable knob. It is read at
 * the point of use, so setting it before the operation is enough.
 */
export function applyInitializationTimeout(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw new Error(`--init-timeout-minutes must be a positive number of minutes, got: ${minutes}`);
  const timeOutInMs = Math.round(minutes * 60_000);
  // Typed readonly, but a plain mutable object at runtime. Verify the write landed so that
  // a future version freezing it fails here rather than silently timing out at 5 minutes.
  (Constants.time as { iModelInitializationTimeOutInMs: number }).iModelInitializationTimeOutInMs = timeOutInMs;
  if (Constants.time.iModelInitializationTimeOutInMs !== timeOutInMs)
    throw new Error(
      "Could not change the iModel initialization timeout: @itwin/imodels-client-management no longer allows Constants.time to be modified.",
    );
  return timeOutInMs;
}

/** Whether a baseline file is ready, still being worked on, or has failed for good. */
export function interpretBaselineState(state: BaselineFileState): "initialized" | "pending" {
  // Mirrors the client's own check in IModelOperations.waitForBaselineFileInitialization:
  // anything outside these three states is terminal.
  switch (state) {
    case BaselineFileState.Initialized:
      return "initialized";
    case BaselineFileState.WaitingForFile:
    case BaselineFileState.InitializationScheduled:
      return "pending";
    default:
      throw new Error(
        `Baseline file initialization failed with state '${state}'. The iModel cannot be recovered and must be deleted and created again.`,
      );
  }
}

export async function runCreateIModel(args: CreateIModelArgs): Promise<string> {
  if (!args.resume && args.seedFile !== undefined && !fs.existsSync(args.seedFile))
    throw new Error(`seed-file does not exist: ${args.seedFile}`);

  await startIModelHost();
  const timeOutInMs = applyInitializationTimeout(args.initTimeoutMinutes ?? DEFAULT_INIT_TIMEOUT_MINUTES);

  if (args.resume)
    return resumeCreateIModel(args, timeOutInMs);

  console.log(`Starting to create iModel '${args.name}' in iTwin ${args.itwinId}`);
  console.log(`Waiting up to ${timeOutInMs / 60_000} minute(s) for the baseline file to initialize once uploaded.`);

  return getHubAccess().createNewIModel({
    iTwinId: args.itwinId,
    iModelName: args.name,
    description: args.description,
    version0: args.seedFile,
  });
}

/**
 * Pick up a `create` that uploaded its baseline but timed out waiting for the hub to
 * initialize it. The iModel and the uploaded file already exist server-side, so this only
 * watches the baseline file's state -- nothing is uploaded again.
 */
async function resumeCreateIModel(args: CreateIModelArgs, timeOutInMs: number): Promise<string> {
  const iModelId = await getHubAccess().queryIModelByName({
    iTwinId: args.itwinId,
    iModelName: args.name,
  });
  if (!iModelId)
    throw new Error(
      `No iModel named '${args.name}' found in iTwin ${args.itwinId}, so there is nothing to resume. Run without --resume to create it.`,
    );

  console.log(`Found iModel ${iModelId}; waiting up to ${timeOutInMs / 60_000} minute(s) for its baseline file to finish initializing...`);

  const authorization = getHubAuthorization();
  const { baselineFiles } = getHubAccess().iModelsClient;
  let warnedWaitingForFile = false;

  await UtilityFunctions.waitForCondition({
    timeOutInMs,
    conditionToSatisfy: async () => {
      const { state } = await baselineFiles.getSingle({ authorization, iModelId });
      if (state === BaselineFileState.WaitingForFile && !warnedWaitingForFile) {
        warnedWaitingForFile = true;
        console.warn(
          "The hub still reports the baseline file as not uploaded. If this does not change, the upload did not complete and the iModel must be deleted and created again.",
        );
      }
      return interpretBaselineState(state) === "initialized";
    },
    // The client's own error type, so a resumed run fails exactly like the original did.
    timeoutErrorFactory: () =>
      new IModelsErrorImpl({
        code: IModelsErrorCode.BaselineFileInitializationTimedOut,
        message: `Timed out waiting for the baseline file of iModel ${iModelId} to initialize. It may still be initializing; run again with --resume to keep waiting.`,
        originalError: undefined,
        statusCode: undefined,
        details: undefined,
      }),
  });

  console.log(`iModel ${iModelId} is initialized.`);
  return iModelId;
}

export const createIModelCommand: CommandModule<unknown, CreateIModelArgs> = {
  command: "create",
  describe: "Create a new iModel in an iTwin",
  builder: (y) =>
    y
      .option("itwin-id", { type: "string", demandOption: true, describe: "The iTwin id (GUID) that will own the new iModel" })
      .option("name", { type: "string", demandOption: true, describe: "Name for the new iModel" })
      .option("seed-file", { type: "string", describe: "Optional path to a local iModel file to use as the seed/baseline" })
      .option("description", { type: "string", describe: "Optional description for the new iModel" })
      .option("init-timeout-minutes", {
        type: "number",
        default: DEFAULT_INIT_TIMEOUT_MINUTES,
        describe: "Minutes to wait for the hub to initialize the uploaded baseline file",
      })
      .option("resume", {
        type: "boolean",
        default: false,
        describe:
          "Do not create or upload anything; wait for the baseline file of the existing iModel with this name to finish initializing",
      }) as never,
  handler: async (argv) => {
    const id = await runCreateIModel({
      itwinId: argv.itwinId,
      name: argv.name,
      seedFile: argv.seedFile,
      description: argv.description,
      initTimeoutMinutes: argv.initTimeoutMinutes,
      resume: argv.resume,
    });
    console.log(id);
  },
};
