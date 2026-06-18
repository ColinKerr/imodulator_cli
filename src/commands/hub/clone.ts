import type { CommandModule } from "yargs";
import { startIModelHost } from "../../host/imodel-host";
import { getHubAccess } from "../../host/hub-access";
import { getAuthorizationCallback } from "../../auth/authorization-callback";

export interface CloneIModelArgs {
  imodelId: string;
  targetItwinId: string;
  name?: string;
  description?: string;
  changesetId?: string;
  timeoutMs?: number;
}

export async function runCloneIModel(args: CloneIModelArgs): Promise<string> {
  await startIModelHost();
  const authorization = getAuthorizationCallback();
  const result = await getHubAccess().iModelsClient.iModels.clone({
    authorization,
    iModelId: args.imodelId,
    iModelProperties: {
      iTwinId: args.targetItwinId,
      name: args.name,
      description: args.description,
      changesetId: args.changesetId,
    },
    timeOutInMs: args.timeoutMs,
  });
  return result.id;
}

export const cloneIModelCommand: CommandModule<unknown, CloneIModelArgs> = {
  command: "clone",
  describe: "Clone an iModel into another iTwin (server-side)",
  builder: (y) =>
    y
      .option("imodel-id", { type: "string", demandOption: true, describe: "Source iModel id (GUID)" })
      .option("target-itwin-id", { type: "string", demandOption: true, describe: "Target iTwin id (GUID) for the new iModel" })
      .option("name", { type: "string", describe: "Name for the cloned iModel (defaults to source name)" })
      .option("description", { type: "string", describe: "Description for the cloned iModel (defaults to source description)" })
      .option("changeset-id", { type: "string", describe: "Latest source changeset to include (defaults to all changesets)" })
      .option("timeout-ms", { type: "number", describe: "Time to wait for clone initialization in milliseconds (default 300000)" }) as never,
  handler: async (argv) => {
    const id = await runCloneIModel({
      imodelId: argv.imodelId,
      targetItwinId: argv.targetItwinId,
      name: argv.name,
      description: argv.description,
      changesetId: argv.changesetId,
      timeoutMs: argv.timeoutMs,
    });
    console.log(id);
  },
};
