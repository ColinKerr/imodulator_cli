import type { CommandModule } from "yargs";
import * as fs from "node:fs";
import { startIModelHost } from "../../host/imodel-host";
import { getHubAccess } from "../../host/hub-access";
import { getAccessToken } from "../../auth/auth-client";

export interface CreateIModelArgs {
  itwinId: string;
  name: string;
  seedFile?: string;
  description?: string;
}

export async function runCreateIModel(args: CreateIModelArgs): Promise<string> {
  if (args.seedFile !== undefined && !fs.existsSync(args.seedFile))
    throw new Error(`seed-file does not exist: ${args.seedFile}`);

  await startIModelHost();
  const accessToken = await getAccessToken();

  return getHubAccess().createNewIModel({
    accessToken,
    iTwinId: args.itwinId,
    iModelName: args.name,
    description: args.description,
    version0: args.seedFile,
  });
}

export const createIModelCommand: CommandModule<unknown, CreateIModelArgs> = {
  command: "create",
  describe: "Create a new iModel in an iTwin",
  builder: (y) =>
    y
      .option("itwin-id", { type: "string", demandOption: true, describe: "The iTwin id (GUID) that will own the new iModel" })
      .option("name", { type: "string", demandOption: true, describe: "Name for the new iModel" })
      .option("seed-file", { type: "string", describe: "Optional path to a local iModel file to use as the seed/baseline" })
      .option("description", { type: "string", describe: "Optional description for the new iModel" }) as never,
  handler: async (argv) => {
    const id = await runCreateIModel({
      itwinId: argv.itwinId,
      name: argv.name,
      seedFile: argv.seedFile,
      description: argv.description,
    });
    console.log(id);
  },
};
