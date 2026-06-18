import type { CommandModule } from "yargs";
import { startIModelHost } from "../../../host/imodel-host";
import { getHubAccess } from "../../../host/hub-access";
import { getAccessToken } from "../../../auth/auth-client";

export interface ListIdArgs {
  imodelId?: string;
}

export interface BriefcaseIdListing {
  imodelId: string;
  briefcaseIds: number[];
}

export async function runListId(args: ListIdArgs): Promise<BriefcaseIdListing[]> {
  await startIModelHost();
  const accessToken = await getAccessToken();
  if (args.imodelId) {
    const ids = await getHubAccess().getMyBriefcaseIds({
      accessToken,
      iModelId: args.imodelId,
    });
    return [{ imodelId: args.imodelId, briefcaseIds: ids }];
  }
  throw new Error("Listing briefcases across all iModels requires --imodel-id; cross-iModel listing is not supported by the hub access API");
}

export const listIdCommand: CommandModule<unknown, ListIdArgs> = {
  command: "list-id",
  describe: "List briefcase ids owned by the user for an iModel",
  builder: (y) =>
    y.option("imodel-id", {
      type: "string",
      describe: "The iModel id (GUID); required",
      demandOption: true,
    }) as never,
  handler: async (argv) => {
    const listings = await runListId({ imodelId: argv.imodelId });
    for (const listing of listings) {
      console.log(`iModel ${listing.imodelId}:`);
      if (listing.briefcaseIds.length === 0)
        console.log("  (no briefcase ids)");
      else
        for (const id of listing.briefcaseIds)
          console.log(`  ${id}`);
    }
  },
};
